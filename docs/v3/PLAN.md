# Blueprint Studio v3 —— 编辑器体验与数据模型升级方案

> 版本：v3.0-draft2（2026-10-18，开工前评审修订；评审记录见 [REVIEW.md](./REVIEW.md)） · 配套文件：[TASKBOARD.md](./TASKBOARD.md)（任务看板 / Agent 分工）
> 本文档只做方案设计，不包含实现代码。文中代码块均为**格式与 API 的示意**，用于固化契约。
> v2 方案与 ADR 001~010 留档于 [../v2/](../v2/)；仍有效的原则继续适用，涉及 IR 结构的条目随本方案以 ADR-011 起修订。

**draft2 修订要点（只列契约级，细节见各节与 REVIEW.md）**：①UI/元素资产的 `graphs` 显式区分事件图与函数图，并补 `layout`；②元素实例覆盖拆为 `props`（自定义属性）/`vars`（提升变量）；③补 `@library/<kind>/<name>` 引用语法与样式表合并顺序；④`theme` 退役、外观属性归 `props`；⑤`flow.call` 作用域改为 `auto|blueprint|project|global`；⑥反射/选择器只作用于图属主自身树，元素/预制体内部不透明；⑦补预制体实例图语义与嵌套事件命名；⑧补齐 M8 依赖、批次 B17/B18、批量验证命令与基线（923 测试 / typecheck 0 错）。

## 0. 已拍板的架构决策（不再讨论）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 工作区 dock 化 | **完全统一**：每个打开的资产（UI/蓝图/脚本/运行视图）都是 dock 树中的面板，可与任何面板互相拖拽分屏、合并成组、点 tab 切换；中央固定 tab 条移除 |
| D2 | UI 布局引擎 | **深度重构，全面 flex 化**：每个元素带 flex 布局属性（VisualElement 式定位模型），编辑视口改为与运行时同引擎的实时布局渲染 |
| D3 | 样式库 | **USS 式**：样式表 = 类选择器 + 属性集；元素挂样式类；合并顺序 = 控件默认值 → 样式类（按表内声明顺序）→ 元素内联覆盖 |
| D4 | 元素库两界 | **内置 = 编辑器级资源库**（用户经编辑器创作、数据文件、所有项目共用、仅组合不造新渲染原语）；**项目 = 项目内用户控件**；基础控件（23 种）升级为代码级原语；预制体（ADR-009）与项目元素并存 |
| D5 | 内嵌蓝图 | **类级**：UI 场景/预制体/元素的 root 各内置一份图（不显示在文件系统、不可拆不可换）；普通控件实例不带图，事件经 sourceNode 路由到最近图属主；变量可提升为实例可编辑 |
| D6 | 独立蓝图资产 | `.bp.json` 保留为**纯逻辑资产**（不绑 UI）；`logicAsset` 挂载机制移除 |
| D7 | 函数作用域 | **三档**：蓝图函数（资产内子图）/ 全项目函数（项目库）/ 全局函数（编辑器库）；右键节点面板三档全部可检索 |
| D8 | v2 兼容 | **干净断裂**：v2 项目拒载（版本门禁）；v2 模板删除、按 v3 重制；roundtrip/e2e 按新契约重写；代码在 `v3` 长分支原地重写，docs/v2/ 留档 |
| D9 | 内置库运维 | 库路径默认 `%USERPROFILE%\.blueprint-studio\library\`、**设置中可配置**；条目改动**即时生效、无版本**；**首版含导出/导入** |
| D10 | 检视器 | 统一为全局检视器：所有资产可检视（无属性资产只显示文件名 + 基本信息）；蓝图 Details 移入检视器（蓝图编辑器变两栏） |
| D11 | 运行 | 运行视图**默认内置工作区**（可停靠 tab + iframe 承载），保留拆出独立窗口；Ctrl+S 后自动重跑（可关） |
| D12 | 设置 | 右上角齿轮 → **模态弹窗** + 左侧分区选择器（通用/快捷键/插件/关于）；插件管理入驻；设置与插件管理不再作为 dock 面板存在 |
| D13 | 文件系统呈现 | 隐藏资产扩展名（`main.ui.json` → `main`，类型徽标区分）；新建/重命名只输主名、自动补全扩展名 |
| D14 | UI 树 | 内嵌进 UI 编辑器左栏（蓝图编辑器同款组织方式）；独立「UI 树」dock 面板移除 |
| D15 | 流程 | 沿用 v2：`v3` 长分支开发（M8/M10/M13 后合回 main）；里程碑 M8 续编、批次 B17 起、契约变更落 ADR-011 起；每批次全量测试绿 |

## 1. 定位与范围

v3 不是新引擎，是 v2 的**编辑器体验与数据模型升级**：外壳统一为单一 dock 心智、UI 编辑器迁移到 Unity UIToolkit 的 Web 范式（flex 布局 + 样式库 + 元素库）、UI 逻辑内嵌进资产本体（UE5 蓝图类/实例心智）、蓝图函数三档作用域、以及一套**用户可创作的编辑器级资源库**（内置元素/内置样式/全局函数）。

**不做清单**（防失控）：多人协作；Python（M4 继续暂缓，契约为其预留）；插件市场/远程注册表；全新渲染原语的代码生成（用户元素仅组合，见 D9）；库条目版本管理（即时生效，见 D9）；运行窗口独立进程化。

### 1.1 需求映射（12 条 + 追加需求 → 落点）

| # | 需求 | 设计章节 | 任务卡 |
|---|---|---|---|
| 1 | 检视器检视所有资产；蓝图 Details 并入检视器 | §4.2 | T8.2 |
| 2 | 运行时窗口默认内置工作区 | §4.5 | T8.5 |
| 3 | 工作区界面可拖拽合并、tab 切换 | §4.1 | T8.1 |
| 4 | 右上角设置按钮 → 弹窗 + 左侧选择器；插件管理入驻 | §4.3 | T8.3 |
| 5 | 文件系统不显示 .json 后缀 | §4.4 | T8.4 |
| 6 | UI 树内嵌 UI 编辑器 | §5.5 | T9.4 |
| 7 | UI 编辑 UIToolkit 化（树/元素库/样式库/两界/属性条目） | §5~§7 | M9+M11 |
| 8 | 场景/预制体/元素 root 内嵌蓝图 + 变量提升（**控件不带图**，控件内建事件按 §8.2 路由到最近图属主） | §8 | M10 + T11.3 |
| 9 | 函数三档 + 节点面板检索 | §9 | T12.1~T12.3 |
| 10 | 反射子节点属性 get/set + 获取元素选择器 + 入参过滤 | §10 | T12.4~T12.7 |
| 11 | 变量节点选择器 | §10.4 | T12.8 |
| 12 | 引用删除后校验报错 | §11 | T13.1 |
| + | 用户可创作内置元素/内置函数（编辑器级资源库；样式表同属资源库） | §7 | T11.4~T11.7 |

### 1.2 逐条验收口径（评审补全，避免「做了但不算」）

| # | 可演示验收（用户视角） |
|---|---|
| 1 | 打开 UI/蓝图/脚本/预制体/元素/样式/纯逻辑资产，检视器分别显示节点属性、蓝图参数与图接口、文件基本信息；蓝图 tab 内不再有独立右栏 |
| 2 | F5/F6 在编辑器内出现运行 tab 并渲染；可拆出独立窗口；Ctrl+S 后自动重跑可关 |
| 3 | 任意两个面板（含左右侧栏）可拖拽分屏/合并成组/点 tab 切换；关闭再打开布局不丢；拆出窗口可用 |
| 4 | 右上角齿轮打开模态设置，左侧四分区（通用/快捷键/插件/关于）；Ctrl+, 定位上次分区；设置与插件不再是 dock 面板 |
| 5 | 文件面板资产行显示主名 + 类型徽标（无 `.json` 后缀）；新建/重命名只输主名并自动补扩展名与目录 |
| 6 | UI 编辑 tab 左栏三分页（UI 树/元素库/样式库），独立「UI 树」dock 面板不存在 |
| 7 | 元素库可拖入实例；样式类可挂载并即时改变外观；两界（内置/项目）边界检查可演示；检视器按布局/容器/外观/行为分组 |
| 8 | 场景/预制体/元素打开的 tab 顶栏有「设计/蓝图」切换；图内变量可勾「提升」并在实例检视器覆盖；保存一次落盘树+图+变量 |
| 9 | 新建函数时可选三档作用域；右键节点搜索能列出三档函数（带徽标）；同名遮蔽有提示 |
| 10 | 反射菜单按当前树生成 `Get/Set <节点>.<属性>`；`ui.get` 的 target 为下拉且按 trait 过滤；`ui.setText` 只接收具 text trait 的句柄 |
| 11 | `var.get/set` 变量名为下拉，含提升徽标；改名级联、删除后校验报错 |
| 12 | 删除被引用节点/变量/函数/样式类/元素后，校验条出现对应 error，点击可跳到引用处 |
| + | 资源库 tab 可新建/编辑/删除内置元素与全局函数；导出 zip、导入冲突三策略可用；改库条目即时反映到打开的项目 |

## 2. 术语增补（v2 术语表继续有效）

| 术语 | 定义 |
|---|---|
| **基础控件** | 代码级渲染原语（v2 的 23 种控件升级而来），随编辑器版本分发，用户不可修改 |
| **元素** | 可复用控件定义 = 子树 + 自定义属性/事件 + 内嵌蓝图。分**内置元素**（编辑器库，所有项目共用）与**项目元素**（项目内） |
| **预制体** | 轻量子树复用（ADR-009 机制保留），无自定义 schema，与元素并存 |
| **样式表 / 样式类** | `.uss.json`：类选择器 → 属性集；元素经 `classes` 挂载 |
| **资源库** | 元素/样式/函数的统一管理面。**内置库**（编辑器级目录）+ **项目库**（项目内） |
| **内嵌蓝图** | UI 资产 root 内置的图集（graphs/variables/events），不可拆不可换 |
| **提升变量** | 内嵌蓝图变量标记「实例可编辑」后，在 UI 检视面板出现并可修改 |
| **图属主** | 事件与反射的作用域单元：节点所在元素实例（元素图）或资产（root 图） |
| **运行视图** | 内置在工作区的运行 tab（iframe），可拆出为独立窗口 |
| **函数作用域** | 蓝图函数（资产内）/ 全项目函数（项目库）/ 全局函数（编辑器库） |

## 3. 数据契约 v3（唯一真源 `src/ir/types.ts`，改动走 ADR）

### 3.0 待落 ADR 队列

| ADR | 主题 | 首卡 |
|---|---|---|
| 011 | IR v3 flex 布局契约 + v2 拒载门禁 | T9.1 |
| 012 | 样式库（.uss.json / classes / 合并顺序） | T11.1 |
| 013 | 元素系统（ElementAsset / 实例化 / 边界） | T11.2 |
| 014 | 内嵌蓝图与事件路由（UIAsset v3 / logicAsset 退役） | T10.1/T10.3 |
| 015 | 函数三档作用域 | T12.1 |
| 016 | 资源库存储与服务端（安全根 / REST / 导出导入 / 快照） | T11.4 |
| 017 | 引用完整性校验 | T13.1 |
| 018 | 类型化元素引用与 trait 过滤 | T12.4 |

### 3.1 UI 资产（场景 / 预制体）

```jsonc
// ui/main.ui.json（kind 字段区分场景与预制体；version 升 3）
{
  "version": 3, "kind": "scene", "name": "main",
  "styles": ["ui/styles/app.uss.json", "@library/styles/base"], // 引用语法见 §3.8
  "root": { /* UINode 树，见 §5.1 */ },
  "graphs": {                                // ★ 内嵌蓝图（D5）：不可拆不可换
    "event": { "kind": "event", "nodes": [], "edges": [], "comments": [] },
    "格式化时间": { "kind": "function", "nodes": [], "edges": [], "params": [], "returns": [] }
  },
  "layout": { "event": { "zoom": 1, "pan": [0, 0] } },   // 各图视图状态（键 = 图名；v2 IRGraphLayout 语义）
  "variables": [ { "name": "packageName", "type": "string", "default": "", "exposed": true } ],
  "events": [ { "name": "loaded", "params": [] } ]      // 自定义事件声明（内建事件不在此列）
}
```

- `logicAsset` 字段与挂载链路**移除**（D6）；内嵌蓝图是 UI 逻辑的唯一挂载方式。
- 预制体 = `kind: "prefab"`（目录约定 `ui/prefabs/` 保留，新建默认写入该目录）。
- **图集合契约（ADR-014）**：`graphs` 的值 = `IRGraph & { kind: 'event' | 'function' }`；每个 UI/元素/预制体资产**恰有一张 `kind:"event"` 的事件图**（键名固定 `event`，显示名「事件图」），其余均为 `kind:"function"` 且必须声明 `params`/`returns`。图键 = 显示名 / 函数名（同名规则见 §9）。`graphs` 不提供任何拆出 / 替换命令路径。
- `layout` 仅保存画布视图（缩放/平移），不是逻辑真源；装载时缺省按 1/0 补齐。
- `events` = 自定义事件声明（`IREventDef[]`），供 `event.send/custom` 使用；内建控件事件不在此声明，由事件图中的 `event.*` 节点承载。
- `styles` / `classes` 的引用与合并规则见 §3.3、§3.8；v2 的 `theme` 字段**退役**（外观属性归 `props`，见 §5.1）。
- 内嵌图复用 v2 IRGraph 全部语义（ADR-006 注释、ADR-008 多次出脚、ADR-010 协作调度与校验码）。

### 3.2 元素资产（ElementAsset）

```jsonc
// ui/elements/statcard.elem.json（项目元素）；内置元素存库目录（§3.5）
{
  "version": 3, "kind": "element", "name": "StatCard",
  "props": [ /* 自定义属性声明：复用 UINodeSchema 的 PropDef 声明 */ ],
  "traits": ["text"],                          // 可选：元素实例对外暴露的 trait（§10.1；缺省无）
  "styles": [ /* 可选：元素自带样式表引用，语法同 §3.8 */ ],
  "root": { /* 子树：基础控件 + 其它元素（按边界规则 §7.3） */ },
  "graphs": { "event": { "kind": "event", "nodes": [], "edges": [], "comments": [] } },
  "layout": {},
  "variables": [],
  "events": [ /* 自定义事件声明：元素图可向外转发（§8.2）；只声明一次 */ ]
}
```

- **实例覆盖**：元素实例 = 宿主树中的
  `UINode = { "type": "__element", "element": "ui/elements/statcard.elem.json" | "@library/elements/StatCard", "name": "card1", "props": { /* 自定义属性覆盖 */ }, "vars": { /* 提升变量覆盖 */ }, "children": [] }`。
  - `props` 只覆盖元素声明的自定义属性（`ElementAsset.props`）；基础控件内部属性 / 元素内部子节点不可从宿主覆盖（保持不透明，§10.3）。
  - `vars` 只覆盖元素图内 `exposed: true` 的变量（§8.3）；两处覆盖互不混用，避免同名歧义。
  - 结构（`root`/`type`）以元素资产为准，实例 `children` 被忽略；实例化 / 预取 / 循环检测复用 ADR-009。
- 元素图的 `event` 图是**类级**图：同一元素的所有实例共用图定义，每个实例拥有独立解释器状态（§8.2）。

### 3.3 样式表（.uss.json）

```jsonc
// ui/styles/app.uss.json（项目样式表）；内置样式表存库目录
{
  "version": 1,
  "classes": {
    "primary-btn": { "props": { "variant": "primary" } },
    "card": { "layout": { "grow": 1, "margin": { "t": 4, "r": 4, "b": 4, "l": 4 } } }
  }
}
```

- 属性集结构与 UINode 的 `layout/container/props` 同构（仅允许可样式化属性，ADR-012 定清单；`id/name/type/events/children` 与 `prefab/element` 引用不可样式化）。
- **应用与合并**（D3）：资产 `styles` 显式列出的表才生效（内置表不隐式套用）；先按 `styles` 数组顺序，再按同一张表内 `classes` 的声明顺序合并，后声明覆盖先声明；最后元素内联 `layout/container/props` 覆盖。基础控件 schema 默认值是最底层。
- 同一节点可挂多个类（`classes: ["card","compact"]`）；类名在「该资产已应用的样式表集合」内全局解析，跨表重名时后表覆盖前表；「查找引用」只在该集合内检索。
- 样式表可同时服务场景/预制体/元素（元素可在自身 `styles` 中声明附加表）；元素实例内部节点的类解析以元素资产为准，宿主样式不穿透元素边界（§7.3）。

### 3.4 函数资产与三档作用域

```jsonc
// 库目录 functions/formatDuration.fn.json（scope: "global"）；项目库同构（scope: "project"）
{ "version": 3, "kind": "function", "scope": "global", "name": "formatDuration",
  "params": [{ "name": "ms", "type": "int" }],
  "returns": [{ "name": "text", "type": "string" }],
  "graph": { "nodes": [], "edges": [] } }
```

- 蓝图函数 = 资产 `graphs` 子图（现状）；全项目函数 = 项目库 `library/functions/`（文件系统隐藏，资源库 tab 管理）；全局函数 = 内置库。
- **调用节点契约**（ADR-015）：`flow.call` 参数 `{ function: string, scope: 'auto' | 'blueprint' | 'project' | 'global' }`，缺省 `scope:'auto'`。`function` 存**未限定函数名**；`auto` 按蓝图 → 全项目 → 全局就近解析（同名遮蔽），显式 `scope` 钉死某一档（找不到即 `ref-function-missing`，不回落）。改名/移动作用域走级联同步，不靠字符串猜测。
- 函数资产文件名 = `<name>.fn.json`；函数名在各自作用域内唯一。项目/全局函数以「函数编辑器」为唯一创作入口（§9）。
- 函数边界规则：**内置只调内置**（全局函数图内只能用基础控件节点、内置节点与其它全局函数，不得出现项目引用，装载期校验 + `ref-element-boundary`）。

### 3.5 内置库存储布局（D9）

```
<库根>/                          # 默认 %USERPROFILE%\.blueprint-studio\library\，设置中可改
  elements/*.elem.json           # 内置元素
  styles/*.uss.json              # 内置样式表
  functions/*.fn.json            # 全局函数
  .history/                      # 库文件同样启用保存前快照（服务端）
```

- 服务端为其开**独立安全根**（与 `_projects/` 平级、互不可越）；REST `/api/library/*`（列表/读写/重命名/删除）。测试/多环境经环境变量 `BP_LIBRARY_ROOT` 覆盖库根（ADR-016）。
- 库条目名 = 文件主干；改名 = 改文件名 + 级联同步所有引用（§11）。库根路径来自设置（`bps.settings.v1`），服务端启动时读取并在每次库操作时校验存在/可写/不与任何项目根重叠。
- 导出 = 依赖闭包打包（zip：所选条目 + 其引用的内置条目 + manifest 指纹清单）；导入 = 合并 + 重名策略（跳过/覆盖/并存改名）。manifest 形状 `{ version:1, createdAt, entries:[{ kind:'element'|'style'|'function', name, sha256 }] }`。**首版不加第三方依赖**：服务端自写 store 模式（不压缩）zip 读写，或降级为目录复制（ADR-016 二选一并锁死）。

### 3.6 纯逻辑资产与脚本（不变项）

`.bp.json` 保留为纯逻辑资产（无 UI 绑定，供 e2e/测试与脚本互转）；`.ts/.py` 脚本系统、蓝图⇄脚本互转（v2 D3 单资产双视图）全部沿用。**范围裁定**：`.bp.json` 的 `IRGraph` 结构不变，仅 `version` 升 3；codegen/解析器只需版本门禁与既有回归（T10.6），不做结构重写。UI/元素/预制体的内嵌图**不提供脚本双视图**（UE5 Widget BP 心智；脚本视图仍只服务 `.bp.json`）。

### 3.7 文件扩展名与徽标（D13）

| 资产 | 扩展名 | 文件面板显示 | 徽标 |
|---|---|---|---|
| UI 场景/预制体 | `.ui.json` | 主名 | UI / ⧉ |
| 元素 | `.elem.json` | 主名 | EL |
| 样式表 | `.uss.json` | 主名 | ST |
| 函数 | `.fn.json` | 不显示（项目库隐藏；内置库在资源库 tab） | — |
| 纯逻辑蓝图 | `.bp.json` | 主名 | BP |
| 脚本 | `.ts` / `.py` | 完整文件名 | TS / PY |

- 显示主名 = 去掉上表「双扩展名」后缀后的主干；未知 `.json`（如 `report.final.json`）与脚本一律显示完整文件名（**例**：`main.ui.json` → `main`，`app.uss.json` → `app`，`a.b.ts` → `a.b.ts`）。
- 新建向导在 M8 仅提供已具备 v3 契约的类型（UI 场景 / 预制体 / 纯逻辑蓝图 / 脚本）；元素 / 样式 / 函数的新建入口在 M11（T11.5 / T11.7）随契约落地，避免产出与 ADR 冲突的骨架。显示与徽标不设门禁。

### 3.8 引用语法（统一，ADR-013 / ADR-016）

| 引用目标 | 写法 | 示例 |
|---|---|---|
| 项目内资产 | 项目根相对 posix 路径（禁止 `..` / 绝对路径） | `ui/elements/statcard.elem.json`、`ui/styles/app.uss.json` |
| 内置库条目 | `@library/<elements\|styles\|functions>/<条目名>` | `@library/elements/StatCard`、`@library/styles/base`、`@library/functions/formatDuration` |

- `UINode.prefab` / `UINode.element` / 资产 `styles[]` / `ElementAsset.styles[]` 统一用上表写法；`flow.call` 的 `function` 用未限定函数名 + `scope`（§3.4），不用路径。
- 装载期解析：项目引用按项目根解析；`@library/*` 按库根解析。越界、缺失、跨边界（内置引用项目）分别报 `ref-element-boundary` / `ref-library-missing` / `ref-element-boundary`（§11），渲染占位不崩溃。

## 4. 外壳统一（M8）

### 4.1 dock 资产化（需求 3）

- 每个打开的资产 = 一个 dock 面板：面板 id `asset:<kind>:<路径>`（`kind` ∈ `ui | blueprint | script | element | style | function`）；**可与任何面板（含左右侧栏）拖拽分屏、合并成组、点 tab 切换、拆出独立窗口**（复用 v2 dropZone/tree/popout 基建与单测）。
- 中央「工作区」固定 tab 条移除；`workspace-store` 降级为**资产注册表**（openTabs/dirty/active 镜像，供 F6、多窗同步与标题使用），持久化真源 = dock 布局（键 `bps.dockLayout.v3`，格式 `{ version:3, root, activePanelId }`）。启动时从布局中的 `asset:` 面板重建 openTabs；关闭面板 → 注册表同步移除；不迁移 v2 布局（v2 键忽略，未知静态面板经 normalize 剔除）。
- **激活面板**：dock store 增 `activePanelId`（点 tab / 打开 / 关闭时维护，持久化）；统一检视器与 F6 以此判定当前上下文。
- 打开已开资产 = 聚焦既有面板；有脏标记关闭时确认；tab 右键：关闭 / 关闭其他 / 关闭右侧（脏面板逐个确认）。
- 面板标题 = 资产主名 + 类型徽标 + 脏标记 ●（脚本显示完整文件名）；资产面板组件为泛型宿主，按 id 解析 kind/path 渲染对应编辑器，拆出窗口据此重建（弹窗页启动时按 `?panel=asset:…` 注册同一 id）。

### 4.2 统一检视器（需求 1）

- **选择协议**（ADR 级实现约定，落 `src/shell/selection/`）：`SelectionDescriptor` =
  `{ source:'ui', assetPath, nodeIds } | { source:'blueprint', assetPath, graph, nodeIds, edgeIds } | { source:'file', path, name, kind, size? } | { source:'library', scope, kind, name }`。
  编辑器在激活 + 选择变化时发布；检视器按 `activePanelId` 与 descriptor 分发到适配器；无编辑器激活时跟随文件面板选中项，再退化为当前资产基本信息。
- 四类内容：① UI 节点（现检视器全部能力：分组/搜索/多选混合态/预制体与元素覆盖编辑）；② 蓝图节点（原 Details 整体迁入：参数/未连线引脚默认值/多选批量/无选中 = 图接口——**蓝图编辑器移除内部右栏**，变两栏 MyBlueprint + 画布）；③ 资产基本信息（文件名/类型/路径/大小——无属性资产仅此；多选 = N 个文件）；④ 资源库条目信息（内置/项目 + 引用数 + 最近修改；M11 填充）。
- 检视器本身仍是右列 dock 面板，可被拖走/拆出；其内容不随面板拆出而丢（状态来自共享 store）。
- 事件面板、控制台等其余面板不动。

### 4.3 设置弹窗（需求 4）

- 顶栏右上角**齿轮按钮** → 模态弹窗（遮罩居中、Esc / 点击遮罩关闭、焦点入弹窗；弹窗内按键不触发全局快捷键）；左侧分区选择器：**通用**（内置库路径 + 校验 + 运行自动重跑开关）/ **快捷键**（v2 设置面板整体迁入）/ **插件**（v2 插件管理面板整体迁入：四态徽标/SSE 安装日志/刷新；移除其「在编辑器中打开」入口）/ **关于**。
- 设置持久化 `bps.settings.v1`（`{ libraryRoot, autoRerun }`）；`libraryRoot` 空 = 服务端默认 `%USERPROFILE%\.blueprint-studio\library\`。M8 的校验仅前端格式校验（绝对路径、不在项目根内、非空/不存在提示），**安全根与越权拒绝由 T11.4 服务端接管**——M8 不声称已提供库读写。
- `Ctrl+,` 改为打开弹窗并定位到上次分区；移除 `settings`、`plugin-manager` dock 面板与工作区虚拟 tab；插件管理的其余能力不变。

### 4.4 文件系统呈现（需求 5）

- 资产行显示主名 + 徽标（§3.7 表）；`.ts/.py` 等照旧显示完整文件名。徽标判断按**最长后缀优先**（`.ui.json` → UI、`.bp.json` → BP、`.elem.json` → EL、`.uss.json` → ST、`.fn.json` → FN），未知 `.json` 显示原文件名的 `{}` 图标。
- 新建对话框：选资产类型 + 输主名 → 自动补全扩展名与目录约定（UI 场景→`ui/`、预制体→`ui/prefabs/`、蓝图→`logic/`、脚本→`logic/`；元素→`ui/elements/`、样式→`ui/styles/`、函数→项目库隐藏（M11 开放））；重命名只输主名、保持原扩展名；`.history` 恢复弹层照旧。
- 双击仅打开当前里程碑已实现的编辑器；元素/样式/函数在 M11 前提示「编辑器 M11 开放」，不弹未实现界面。

### 4.5 运行视图内置（需求 2）

- 新面板 `runtime`（单实例）：iframe 承载 `runtime.html?project=&ui=&mode=&embed=1&run=<nonce>`（样式与全局状态隔离；控制台 BroadcastChannel 镜像照旧）。
- **embed 契约**：`embed=1` 时运行页隐藏顶栏与页内控制台 UI（消息仍镜像），内容区铺满；`run` 为自增 nonce，重跑 = 更新 iframe src（同一面板内不双开）。
- F5 = 打开/聚焦运行面板并重跑主 UI；F6 = 运行当前激活的 UI 资产（非 UI → toast，不切换运行目标）；面板内「拆出独立窗口」= `window.open(runtime.html…)`（不带 embed）+ 关闭内置面板（pong 探测沿用）；面板被拆到 dock 独立窗口时不重复处理。
- Ctrl+S 保存成功（任意资产）→ 若运行面板打开且设置 `autoRerun`（默认开）→ 自动重跑；调试观察（WS debug.v1）对 iframe 运行同样生效。
- **键盘**：焦点在 iframe 内时，运行页把 F5/F6/Ctrl+S 经 `postMessage` 转给父窗口执行，避免「点进运行视图后快捷键失效」。

## 5. flex 布局引擎（M9，深度重构 D2）

### 5.1 布局契约（ADR-011）

```jsonc
// UINode v3（示意）：transform 退役，布局属性顶格
{
  "id": "", "name": "list", "type": "list",
  "classes": ["card"],                        // 样式类（§6）
  "layout": {                                 // 自身作为流式子项 + 定位
    "position": "relative",                   // 'relative' | 'absolute'
    "grow": 0, "shrink": 1, "basis": "auto",  // 流式分配
    "alignSelf": "auto", "order": 0,
    "size": { "w": "auto", "h": 24 },         // 首选尺寸（流式）/ 绝对尺寸（absolute）
    "margin": { "t": 0, "r": 0, "b": 0, "l": 0 }
    // absolute 专属：left/top/right/bottom（px 或 %，含锚点语义）
  },
  "container": {                              // 容器专属（容器原语与元素根）
    "direction": "column", "wrap": "nowrap",
    "justify": "start", "align": "stretch",
    "gap": 4, "padding": { "t": 0, "r": 0, "b": 0, "l": 0 },
    "overflow": "visible"                     // visible | hidden | scroll
  },
  "props": { },                               // 内容/行为属性（文本、值、列定义…）
  "events": ["selectionChanged"], "children": []
}
```

- 渲染映射 = CSS flex 直译（容器 `display:flex`；absolute 子项 `position:absolute`），编辑态与运行态**同引擎同构**。
- 23 种基础控件全部按新契约重造属性模型；`transform` / `theme` 字段**退役**：`rotation`、颜色、字号、padding 等外观属性进 `props`（检视器「外观」组），仅布局相关进 `layout/container`；`anchors` 并入 absolute 定位语义（ADR-011 给出 left/top/right/bottom 与锚点的换算）；ScrollBox 保留原语地位（= `overflow:scroll` 的快捷封装）。
- **字段语义**（ADR-011 必须逐条落表）：`position` 默认 `relative`；`grow/shrink/basis` 映射 flex-grow/shrink/basis；`size.w/h` 接受 `number | 'auto' | '<n>%'`（流式 = flex-basis/首选尺寸，absolute = 实际尺寸）；`margin/padding` 四向 px；`left/top/right/bottom` 仅 `position:'absolute'` 生效，可 px 或 `%`（相对父内容盒），成对出现时按 CSS 拉伸规则；`overflow` ∈ visible/hidden/scroll（scroll 启用滚动容器）；`order` 只影响流式排序，不改变层叠；absolute 子项层叠按树序。
- `events` 保持 `string[]`（已绑事件名，编辑期由内嵌事件图自动维护；仅展示/事件面板用，不作为逻辑真源）；`classes` 顺序不参与合并优先级（§3.3）。

### 5.2 渲染器

`src/runtime/render/` 重写为 flex 布局渲染（保留 keyed reconcile、dataview 虚拟滚动、编辑态交互冻结）；旧 `bps-*` 固定结构 CSS 改为按 UINode 布局属性生成内联样式 + 主题 token 类。

### 5.3 编辑视口（WYSIWYG）

- 视口直接用运行时渲染器实时布局（改属性即时重排）；缩放平移由外层 CSS transform 承担（v2 方案沿用）。
- 交互模型（Unity UI Builder 心智）：**流式子项不做自由拖拽**——位置由 flex 属性决定，编辑 = 检视器改属性 + **树内拖拽重排**（含跨父移动）；**absolute 元素保留自由拖拽/对齐吸附线/键盘微调/框选**。
- 多选对齐工具条仅对 absolute 元素生效；悬停/选中 overlay 沿用几何计算。

### 5.4 检视器 UIToolkit 条目

标准分组（基础控件 schema 声明各自出现的条目）：**布局**（position 模式/grow/shrink/basis/alignSelf/order/margin/尺寸）· **容器**（direction/wrap/justify/align/gap/padding/overflow）· **文本** · **外观** · **行为**（含内建事件区）· **数据** · **预制体/元素**（引用 + 覆盖 + 断开物化）· **变量**（实例的提升变量覆盖，§8.3）。搜索/折叠/多选混合态保留。
- 预制体实例可「断开预制体」物化为子树（v2 语义保留）；**元素实例首版不提供断开**（物化会丢失类级图与自定义 schema，避免不可逆误解——如需脱离元素，删除后重建为普通子树）。

### 5.5 UI 编辑器结构（需求 6）

UI 编辑 tab = **左栏三分页（UI 树 / 元素库 / 样式库，库页 M11 填充）+ 中央画布**；独立「UI 树」dock 面板移除。设计/蓝图双模式切换见 §8.1。

## 6. 样式库（M11，D3）

- 样式库面板（UI 编辑器左栏第三页）：本资产应用的样式表列表 + 类列表（新建/编辑/删除/重命名）；「查找引用」= 搜索哪些节点挂了该类。
- 解析管线：装载资产 → 收集 `styles` 声明的样式表（项目引用 + `@library/styles/*`，**不隐式套用内置表**）→ 每节点按 `classes` 合成有效属性（§3.3 合并顺序）→ 渲染器与检视器显示**合成后有效值**（覆盖处高亮、可跳转来源）。
- 内置样式表 = 库目录 `styles/`；边界规则同元素（§7.3）。样式表改动的即时生效机制见 §7.6。

## 7. 元素系统与资源库（M11，D4/D9）

### 7.1 基础控件

23 种控件 → 代码级原语（声明式 schema 结构沿用 v2，属性按 §5.1 重造），作为内置元素库的「基础控件」组，不可用户修改。

### 7.2 元素创作器

- 新建元素（项目：`ui/elements/`；内置：库目录）→ 打开**元素编辑器**（UI 编辑器同款左栏 + 画布 + 设计/蓝图双模式）。
- 自定义属性/事件在「元素设置」区编辑（PropDef 声明式，检视器同款编辑器复用）；元素根子树按边界规则组合（§7.3）。
- 元素实例：画布右键「元素」分组 / 元素库面板拖入；实例 = `type:'__element'` + `element` 引用 + `vars` 覆盖（浅覆盖复用 ADR-009：结构以元素为准，自定义属性与提升变量可覆盖）。
- 元素改动反射到引用处（装载期预取缓存，ADR-009 机制）；循环检测/深度上限复用。

### 7.3 边界规则（严格执行）

| 作用域 | 可用素材 |
|---|---|
| 内置元素 / 内置样式 / 全局函数 | 基础控件 + 其它内置元素 + 内置样式类 + 全局函数 + 内置节点 |
| 项目元素 / 项目样式 / 全项目函数 | 基础控件 + 内置 + 项目侧全部 |
| UI 场景 / 预制体 | 同项目侧 |

装载期检查（引用越界/缺失 → 中文错误 + 占位）+ 蓝图校验（§11）双关卡。

### 7.4 资源库 tab 与管理

- dock 面板 `library`（默认不在布局，「面板 ▾」/文件面板入口打开）：两页签 **内置库 | 项目库**，各三栏列表（元素/样式/函数）+ 条目详情（引用数/最近修改/新建/重命名/删除）。
- 项目库：元素（`ui/elements/`，文件面板可见）+ 样式（`ui/styles/`）+ 全项目函数（`library/functions/`，文件面板隐藏，资源库 tab 管理）。
- 删除/重命名 → 引用完整性校验兜底（§11）；改名级联同步。

### 7.5 库导出/导入（首版含，D9）

- 导出：资源库条目多选 → 依赖闭包计算（元素 → 子元素/样式/函数）→ zip（同 §3.5 结构 + manifest：条目清单与指纹）。
- 导入：选择 zip/目录 → 冲突处理（跳过/覆盖/并存改名）→ 落库目录；跨机打开项目缺库条目时，装载校验输出缺失清单。

### 7.6 库变更即时生效（D9「无版本」的落地机制）

- 服务端在库文件变化后经 `/api/library/watch`（SSE）广播 `{ kind, name, action:'saved'|'deleted'|'renamed' }`；资源库面板与已打开资产订阅。
- 编辑器收到事件 → 失效库条目缓存 → 重解析受影响资产（场景/元素/样式表）→ 重渲染；不要求用户重开 tab。
- 元素/样式/函数的「被引用资产」由当前打开资产的引用图计算；无引用则只刷新资源库列表。服务不可用/SSE 断开时降级为「下次打开生效」，不阻塞编辑。
- 本机制不引入版本号；导出/导入只做跨机迁移兜底（§7.5）。

## 8. 内嵌蓝图与运行时（M10，D5）

### 8.1 数据与编辑（设计/蓝图双模式）

- UI 资产 tab 顶栏模式切换：**设计 | 蓝图**（UE5 Widget Blueprint 心智）。蓝图模式 = MyBlueprint（变量/函数/事件/注释，含作用域 UI §9）+ React Flow 画布；节点 Details 走统一检视器（§4.2）。
- 保存 = 整资产一次落盘（树 + 图 + 变量）；校验对内嵌图同样执行。
- 内嵌蓝图**不可拆出、不可替换、不显示在文件系统**（无任何 detach/replace 命令路径）。

### 8.2 事件路由（类级图 + sourceNode）

- 运行单元：每个 UI 资产一个 root 图解释器；每个**元素实例**、每个**预制体实例**各一个类图解释器（图定义取资产/元素/预制体的 `event` 图；无图零成本、惰性创建）。场景/预制体/元素自身的 `event` 图即其「类图」。
- 控件内建事件 → **最近图属主**（节点在元素/预制体子树内 → 该实例的类图；否则 → 资产 root 图），payload 注入 `sourceNode`（图属主树内名字，ADR-010 机制沿用）。图属主树以**实例展开后的有效树**为准；元素/预制体内部对宿主不透明。
- 元素/预制体自定义事件向外转发：类图 `event.send`（上抛）或内建事件标记透传 → 宿主图以 `event.custom` 接收；事件名 = 从宿主到该实例的**实例路径** + 事件名，用 `.` 连接（如 `card1.save`、`list1.row.clicked`，命名空间防冲突）。转发链纳入总线环保护，深度上限同 ADR-009。
- `event.start` / `event.timer` / 自定义事件定义于各图自身（元素/预制体类图亦有 `event.start`，每个实例触发一次）；`flow.call` 按作用域解析（§9）。

### 8.3 变量提升（需求 8 后半）

- MyBlueprint 变量勾「提升」（复用 `IRVariable.exposed`，v2 休眠字段落地）→ 出现在 UI 检视面板「变量」区。
- 场景自身 = 直改 root 图变量默认值；**元素/预制体实例** = 覆盖值存实例 `vars`，运行时以覆盖值为该实例解释器的变量初值；未覆盖键回落类图默认值。
- 检视器中提升变量显示类型徽标 + 默认值回退提示；取消 `exposed` 后实例 `vars` 中的孤儿键由校验报 `ref-variable-missing`（§11），运行期忽略。

## 9. 函数三档作用域（M12，D7）

- 定义处：MyBlueprint「函数」区新建时选作用域（蓝图 = 资产内子图 / 全项目 = 项目库 / 全局 = 内置库）；全项目与全局函数在**函数编辑器**（蓝图画布 + 统一检视器编辑入参/返回值 + 动态引脚渲染）创作。函数资产同样可被统一检视器检视（基本信息 + 图接口）。
- 调用：`flow.call` 参数 `{ function, scope }`（契约见 §3.4）；解析顺序 蓝图 → 全项目 → 全局（同名就近遮蔽，检索面板显示遮蔽提示）。**函数编辑器与调用点共用同一解析器**（T12.9）。
- **右键节点面板检索**（需求 9）：三档函数全部列出（搜索 + 「函数」分组），条目带作用域徽标（蓝图 · 项目 · 全局）；键盘导航/最近使用沿用 v2 节点搜索。
- 边界：全局函数图内只能用内置节点 + 基础控件节点 + 其它全局函数（§7.3）；函数入口/出口动态引脚随签名渲染（v2 TODO 补齐）；函数签名改名/改参数走级联同步 + 校验（§11）。

## 10. 蓝图节点系统增强（M12）

### 10.1 类型化元素引用与 trait（ADR-018）

- 新值类型族 `UiHandle<控件类型>`（`isTypeAssignable` 同型可赋值 + 泛化规则）；元素实例为 `UiHandle<__element>`。
- 控件 schema 声明 **trait**（如 `text`、`items`、`value`）；`ElementAsset.traits` 可声明元素实例的对外 trait（如一个卡片元素声明 `text`）；节点入参可声明所需 trait，选择器与连线按 trait 过滤（需求 10 后半：设置文本只收文本/按钮类控件）。
- 首版元素实例仅暴露其显式声明的 trait；未声明 = 无 trait（不会被 `ui.setText` 等接受），避免按内部结构猜测。

### 10.2 获取元素节点（子节点选择器，需求 10）

- `ui.get` 升级：入参 `target` 从自由文本改为**子节点选择器**（下拉列出图属主**自身树**内子节点，按声明的 trait 过滤），输出 `UiHandle<类型>`；选择存**节点名**（树内唯一），不落盘为静态副本——树变更后下拉实时刷新，已选节点被删走校验报错（§11）。
- 图属主树中的元素/预制体实例整体是一个可选节点（`UiHandle<__element>`）；其**内部子节点不进入下拉**（不透明，§10.3）。

### 10.3 反射 get/set 属性节点（需求 10 前半）

- 右键节点面板新增「设计器」分组：按图属主树**实时反射**生成条目——每子节点（**仅图属主自身树，不下钻元素/预制体实例内部**）的每个可反射属性生成 `Get <节点>.<属性>` / `Set <节点>.<属性>`；落盘为通用 `ui.getProp` / `ui.setProp` 节点（params: nodeName + propId），运行时直读写。
- 可反射属性 = schema PropDef 显式标记 `reflect: true`（ADR-018 新增字段；默认 false，23 控件按需标注）；不暴露内部生命周期字段。对元素/预制体实例整体，反射 `name/visible` 等公共属性；其自定义属性通过 `props` 覆盖 + `vars` 另行编辑（不做通用反射）。

### 10.4 变量选择器（需求 11）

`var.get` / `var.set` 的 `varName` 从自由文本改为下拉：本图所属资产的变量列表（含提升徽标）。全项目/全局函数图无资产变量 → 下拉空态 + 提示「函数图无资产变量」；改名级联，删变量走校验。

### 10.5 特有节点入参过滤与新增节点

- 新增对象方法风格节点：`ui.setText`（trait: text）等；`ui.setValue/listSetItems/setTitle` 迁移到类型化签名；入参类型 = `UiHandle<具 trait>`。
- PinDragMenu 兼容过滤、自动转换节点逻辑（v2）对 UiHandle 族生效。

## 11. 校验器 v3：引用完整性（M13，需求 12）

新增 issue 码（error 级，ValidationBar 点击跳转）：

| 码 | 触发 |
|---|---|
| ref-node-missing | 反射/选择器节点引用的子节点已被删除（含改名后未级联的孤儿） |
| ref-variable-missing | var.get/set 引用的变量已删除 |
| ref-function-missing | flow.call 引用的函数（三档任一）已删除/越界 |
| ref-style-missing | 节点挂的样式类在已应用样式表中不存在 |
| ref-library-missing | 引用的内置库条目在本机不存在（跨机缺库） |
| ref-element-boundary | 元素引用越界（内置引用项目）/ 循环 |

- 改名走**级联同步**（变量/函数/元素/样式类/事件名，v2 event.custom 同步机制扩展）；删除不阻止、由校验报错（需求 12 语义）。`ref-node-missing` 只在**外部改文件/改名未级联/资产被手工编辑**时出现；编辑器内改名保证级联。
- 校验输入扩展：资产树 + 内嵌图 + 库清单（跨文件校验，装载期预取）；服务不可用/离线时跳过 `ref-library-missing` 并在校验条提示「库清单不可用」，不误报。
- 点击跳转：节点/变量/函数/样式类引用 → 打开对应资产 tab 并定位（图/节点/属性）；跨文件引用（元素/库条目）→ 打开只读预览或资源库条目详情。既有校验码**共 12 个**（broken-edge、dangling-exec、duplicate-node-id、event-def-missing、event-no-entry、exec-through-pure、invalid-asset、narrowing-conversion、type-mismatch、unconnected-required-input、unknown-node、unused-variable），T13.1 需保证全部不回退。

## 12. 模板与示例（M13）

- `templates/empty`：空场景（flex 容器 root + 内嵌空事件图 + `version:3` UI 资产 + v3 `project.json`，`engineVersion:"3.0.0"`）。
- `templates/log-analyzer` 重制：flex 布局 + 内嵌蓝图版（`system.readFile` → `convert.androidLogParse` → `ui.listSetItems` → `system.print` 全链进 root 图）+ 示例样式表 + 一个示例项目元素（演示库用法）。
- v2 模板删除；`_projects/` 旧项目拒载（打开时明示「v3 不兼容 v2 项目」）。**版本门禁**：项目打开时校验 `project.json.engineVersion` 主版本 ≥ 3，资产打开时校验 `version:3`；不符给出中文错误并拒绝进入编辑器（T9.1 / T13.2 落地）。

## 13. 里程碑（垂直切片 + 不做清单）

| 里程碑 | 目标（可用线） | 不做 |
|---|---|---|
| **M8 外壳统一** | dock 资产化 + 统一检视器 + 设置弹窗 + 文件呈现 + 运行内置——编辑器外壳全部就位 | 数据契约（仍用 v2 IR；元素/样式/函数的新建入口随 M11 契约开放） |
| **M9 flex 引擎** | IR v3 布局契约 + 渲染器 flex 化 + WYSIWYG 视口 + UI 树内嵌 + 检视器条目化 | 样式库/元素（M11） |
| **M10 内嵌蓝图** | UIAsset v3 图内嵌 + 双模式 + 事件路由 + 变量提升 | 函数三档（M12） |
| **M11 库系统** | 样式库 + 元素系统 + 资源库 + 导出导入 | 反射节点（M12） |
| **M12 蓝图创作力** | 函数三档 + 检索 + 类型化引用/选择器 + 反射节点 | 校验新码（M13） |
| **M13 校验与交付** | 引用完整性校验 + 模板重制 + roundtrip/e2e 重写 + 文档 + 勾验 | — |

依赖链：M8 ∥ M9 → M10 → M11 → M12 → M13（M8 与 M9 可并行启动；M11 的契约卡可与 M10 并行）。合并点：M8 后、M10 后、M13 后合回 main。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| flex 深改回归面大（渲染/视口/模板/测试全动） | 契约先行（ADR-011 定型再动手）；每批次全量测试绿；T9.2 保留旧渲染器对照跑 23 控件视觉基线 |
| dock 面板数量膨胀（多资产打开） | 布局持久化版本升级容错（v2 normalize 沿用）；tab 溢出滚动；非激活面板挂起重渲染 |
| 元素实例解释器开销 | 惰性创建（无图元素零实例化成本）；千节点/万行性能卡回归不倒退 |
| 库路径可配（安全/越权） | 独立安全根 + 路径校验（存在/可写/不与项目根重叠）+ 服务端拒绝越界 |
| 即时生效无版本（改库波及所有项目） | 引用完整性校验 + 库文件 .history 快照 + 导出导入兜底 |
| 内嵌图与纯逻辑资产双轨认知负担 | 文档明确心智（UI 逻辑 = 内嵌；纯逻辑 = 独立资产）；模板只用内嵌 |
| 干净断裂后旧项目不可用 | 版本门禁明示；docs/v2/ 留档；git 历史可回看 |
| 动态资产面板 × 拆出窗口 × 布局还原 | 面板 id 即持久化键；弹窗页按 `?panel=asset:…` 重建同一注册项；未知面板容错；12 面板布局往返单测（T8.1） |
| iframe 运行视图焦点丢失快捷键 | embed 页 postMessage 转发 F5/F6/Ctrl+S（§4.5）；T8.5 实测 |
| 库即时生效带来重解析抖动 | 失效缓存 + 受影响资产集合 + 合并刷新；SSE 断开降级「下次打开」（§7.6） |
| 导出/导入 zip 引入依赖或跨平台差异 | 首版自写 store 模式 zip（不压缩）或目录复制，ADR-016 锁死；manifest 指纹自校验（§3.5） |

## 15. 总验收标准（DoD 总纲）

1. **12 条需求 + 追加需求逐条可演示**（§1.1 映射表 + 各章 DoD）。
2. **roundtrip v3**：全节点样例（含新契约资产：场景/元素/样式/函数）幂等全绿。
3. **e2e v3**：模板新建 → 拼装（元素/样式）→ 内嵌蓝图连点 → 内置运行视图观察 → 库导出导入 → 校验报错，全绿。
4. **每批次**：全量测试绿 + typecheck 0 错 + 构建绿（基线数量随重写允许变化，当批记录）。当前（draft2 开工前）基线：**923 测试全绿、typecheck 0 错**。全量测试命令（PowerShell 无 glob 展开，逐文件传入）：
   `node .\node_modules\tsx\dist\cli.mjs --test (Get-ChildItem src,server,tests -Recurse -Filter *.test.ts | % FullName)`；
   typecheck：`node .\node_modules\typescript\bin\tsc --noEmit`；构建：`node .\node_modules\vite\bin\vite.js build`。
5. **TA.4 视觉勾验**：UIToolkit 条目 / 双模式 / 资源库 / 设置弹窗 / dock 拖拽，截图基线 + 清单人工勾验（M9/M11 各自留中间截图，最终 TA.4 汇总）。

---

*本方案为 v3 唯一设计真源；契约级变更（IR v3 / 文件格式 / NodeSpec / 库布局）必须走 `docs/v3/adr/`（自 011 起）记录并由 PM-Agent 知会全体。*
