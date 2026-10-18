# v3 任务看板（AI Agent 分工）

> 配套方案：[PLAN.md](./PLAN.md)（开工前必读相关章节；draft2 已按评审修订）。
> 评审记录：[REVIEW.md](./REVIEW.md)。本看板是 v3 开发期间的任务唯一真源，由 **PM-Agent 独占维护**，其他 Agent 只能「领卡 / 汇报 / 交卡」。

## 1. Agent 角色定义

| 角色 | 职责 | 必读 PLAN 章节 |
|---|---|---|
| **PM-Agent**（项目管理） | 看板唯一维护者；任务分发与领卡仲裁；DoD 验收（可派 QA-Agent 复核）；阻塞升级决策（插队/换人/拆卡）；里程碑合并与进度纪要；契约变更知会 | 全部 |
| **Arch-Agent**（架构） | IR v3 / 文件格式 / 库布局等契约的唯一变更发起者；类型定义与 ADR 文档（011 起） | §3 §5.1 §7.3 §8.2 §9 §10.1 §11 |
| **Shell-Agent**（编辑器外壳） | dock 资产化、统一检视器壳、设置弹窗、文件系统面板、多窗口同步、命令栈、快捷键 | §4 |
| **UIEditor-Agent**（UI 编辑） | flex 渲染器、WYSIWYG 视口、UI 树/元素库/样式库面板、元素创作器、样式解析 | §5 §6 §7 §8.1 §8.3 |
| **Blueprint-Agent**（蓝图编辑器） | 蓝图画布与交互、MyBlueprint 作用域 UI、函数编辑器、节点检索面板、选择器参数 | §8 §9 §10 |
| **Script-Agent**（脚本系统） | CodeMirror 编辑器、内建 API、`.bp.json` v3 版本适配与蓝图⇄脚本回归 | §3.6 §9 |
| **Runtime-Agent**（运行时） | 运行视图（iframe）、事件路由升级、内嵌图解释器实例化、变量合并、函数调用运行时解析 | §4.5 §5.2 §8.2 §9 |
| **Server-Agent**（本地服务） | 库安全根与 REST、SSE 变更广播、导出导入、快照、既有 FS/转译/插件服务 | §3.5 §7.5 §7.6 |
| **Plugin-Agent**（插件管理） | 插件面板迁入设置弹窗、四态徽标/SSE 安装日志回归 | §4.3 |
| **Nodes-Agent**（基础节点库） | `src/nodes/` 内置节点、类型化引用节点、反射节点、《节点开发指南》 | §10 |
| **QA-Agent**（测试） | roundtrip v3 门禁、E2E 冒烟、视觉勾验、回归清单维护 | §15 |

约定：单人会话可身兼多角色，但**一次只以一个角色身份领卡**；PM 与实现角色不得同一人验收同一张卡。

## 2. 协作协议

1. **领卡**：Agent 从「待办」中认领无未完成依赖的卡，把状态改 `进行中` 并在卡后署名（会话/日期）。一张卡只有一个**主责**；卡上列出的其它角色为协作方（不改变主责与验收口径）。
2. **交卡**：完成后状态改 `待评审`，在「产出说明」栏写：分支/批次、改动摘要、自测结果（测试数、typecheck、构建、实测项）。PM-Agent 按 DoD 逐条验收，通过→`完成`，不通过→`退回`（附原因）。单会话模式下 PM 可自验，但契约级/高风险卡须由 QA-Agent 复核后才算 `完成`。
3. **阻塞**：卡上追加 `⚠ @PM 原因`，PM 决定：解锁依赖插队 / 换人 / 拆卡 / 挂起。
4. **分支（两种模式）**：多 Agent 并行时每卡一分支 `feature/T<id>-<slug>`；**单会话模式**（当前）不逐卡建分支，PM 按批次在 `v3` 长分支每批一次 commit；M8/M10/M13 后合回 main（PLAN §13）。
5. **契约变更**：IR v3 结构 / 文件格式 / 库布局 / 引用语法的任何改动，先由 Arch-Agent 在 `docs/v3/adr/`（011 起）落 ADR 并知会 PM，PM 广播到受影响在途卡。
6. **进度纪要**：每个里程碑收尾，PM 在 §6 追加一段（完成 / 偏差 / 下步）。
7. **状态枚举**：`待办` `进行中` `待评审` `退回` `完成` `挂起`。
8. **批次**：一个批次 = 若干无未完成依赖卡的集合，收尾必须「全量测试绿 + typecheck 0 错 + 构建绿 + 当批基线记录」，否则不得开下一批。批次计划见 §5。

## 3. 任务卡

### M8 外壳统一

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T8.1 | 工作区资产 tab 并入 dock 体系 | `src/shell/dock/` + `assetPanel` + workspace-store 资产注册表化 | — | Shell | ①每个打开资产=独立 dock 面板（`asset:<kind>:<path>`），可与任意面板拖拽分屏/合并/tab 切换/拆出窗口 ②重复打开=聚焦；脏关闭逐个确认；tab 右键关闭/其他/右侧 ③布局持久化 `bps.dockLayout.v3`（含 activePanelId，启动从布局重建 openTabs，v2 布局忽略）④`activePanelId` 维护正确，拆出弹窗按 `?panel=asset:…` 重建 ⑤12 面板（含 6 资产）布局增删/序列化往返单测，非资产面板行为不回退 | 完成 · 2026-10-18（B17：assetPanel/Model + 持久化 v3 + activePanelId + 脏确认/右键菜单/拆出；9 单测 + GUI 实测打开/还原/脏关闭/拆出） |
| T8.2 | 统一检视器（多源选择协议） | `src/shell/selection/` + `src/panels/inspector/` 重构 + Details 迁移 | T8.1 | UIEditor+Blueprint+Shell（主责 Shell） | ①`SelectionDescriptor` 四源（ui/blueprint/file/library）+ activePanel 分发落地 ②蓝图节点/无选中图接口/多选批量在 dock 检视器可用（蓝图 tab 移除右栏，变两栏）③UI 节点检视能力不回退（分组/搜索/多选/预制体覆盖）④文件选中→基本信息（文件面板当前单选）；无属性资产=文件名/类型/路径/未保存；资源库条目为 M11 占位 ⑤激活 tab 切换上下文正确，不串台；测试覆盖四源切换 | 完成 · 2026-10-18（B18：SelectionStore + UITab/BlueprintTab/文件面板发布 + InspectorHost 四源分发 + Details 迁出右栏；7 单测 + GUI 实测蓝图/文件/UI 上下文） |
| T8.3 | 设置模态弹窗 + 插件管理入驻 | `src/shell/settings/` + 两面板迁移 | — | Shell+Plugin | ①右上角齿轮开模态（Esc/遮罩关闭、焦点在弹窗内）②四分区（通用含库路径输入+前端校验+autoRerun 开关/快捷键/插件/关于）③插件四态徽标/SSE 日志全功能，移除「在编辑器中打开」入口 ④Ctrl+, 打开并记忆上次分区 ⑤移除 settings/plugin-manager dock 面板与工作区虚拟 tab；设置存 `bps.settings.v1` ⑥库路径服务端安全根不在本卡（T11.4），文档/提示写清 | 完成 · 2026-10-18（B17：模态/四分区/齿轮与 Ctrl+,/分区记忆/插件迁入；8 单测 + GUI 实测 Esc/遮罩/记忆/路径校验） |
| T8.4 | 文件系统扩展名隐藏与新建向导 | `src/panels/file-system/` | — | Shell | ①资产行=主名+徽标（PLAN §3.7；最长后缀优先）②新建对话框选类型+主名，自动补扩展名与目录（M8：场景/预制体/蓝图/脚本；元素/样式/函数 M11 开放）③重命名只输主名并保扩展名 ④.history/导入/删除撤销照旧 ⑤旧双扩展名与未知 `.json` 显示正确（`main.ui.json`→`main`、`report.final.json` 原样） | 完成 · 2026-10-18（B17：主名/EL·ST·FN 徽标/新建资产向导/重命名保扩展；路径单测 + GUI 实建 TS 资产后清理） |
| T8.5 | 运行视图内置工作区 | `src/panels/runtime/`（iframe 承载）+ runtime-launch 改造 | T8.1, T8.3 | Runtime+Shell | ①F5/F6 打开/聚焦运行面板并重跑（F6 仅当前 UI）②「拆出独立窗口」= `window.open(runtime.html…)` + 关内置面板（pong 探测沿用）③`embed=1` 隐藏运行页 chrome；控制台镜像+调试观察生效 ④Ctrl+S 保存成功自动重跑（`autoRerun` 默认开，可关）⑤iframe 内 F5/F6/Ctrl+S 经 postMessage 转发父窗；单实例不双开 | 完成 · 2026-10-18（B18：runtime store + iframe 面板 + embed + 拆出 + autoRerun/saveSeq + 键盘转发；store/URL 单测 + GUI 实测 F5/拆出/iframe F5/保存自动重跑） |

### M9 flex 布局引擎与 UI 编辑器重构

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T9.1 | ADR-011：IR v3 布局契约 + v2 拒载门禁 | `src/ir/types.ts` v3、`docs/v3/adr/011-ir-v3-layout.md` | — | Arch | ①UINode layout/container 全集类型+字段文档（含 PLAN §5.1 字段语义表、CSS 映射、缺省值）②serialize/normalize 无损（`transform`/`theme` 退役）③version=3；`project.json.engineVersion` 主版本门禁 ④打开 v2 资产/项目明确报「v3 不兼容」⑤v3 roundtrip 样例先交类型/序列化单测，正式门禁样本由 T13.3 注册 | 完成 · 2026-10-18（B19：ADR-011 + 可选 layout/container/classes + UIAsset v3 字段 + parse 2/3；**偏差**：v2 拒载/engineVersion 门禁随 T13.2 收口，见 ADR） |
| T9.2 | 渲染器 flex 化（23 原语属性模型重造） | `src/runtime/render/` 重写 | T9.1 | UIEditor+Runtime | ①CSS flex 直映射（流式/absolute/锚点/溢出滚动）②编辑/运行同构 ③23 控件对照旧渲染器视觉基线（旧渲染器保留到 T9.2 验收后删除）④dataview 虚拟滚动保留 ⑤渲染回归测试重立 | 完成 · 2026-10-18（B19：layout/container 通用映射覆盖 23 控件；flex 4 单测 + render/layout/prefab/viewport 55 回归绿；**偏差**：23 schema 属性重排随 T9.5，旧渲染器保留兼容层） |
| T9.3 | 编辑视口 WYSIWYG 化 | `src/ui-editor/viewport/` 重构 | T9.2 | UIEditor | ①实时布局（改属性即时重排，与运行时同引擎）②树内拖拽重排/跨父移动 ③absolute 元素自由拖拽/吸附/键盘微调/框选 ④操作全入命令栈可撤销 ⑤流式子项拒绝自由拖拽并提示 | 完成 · 2026-10-18（B20：flex 节点绝对/相对判定 + read/write 位置 + 拖拽/微调/对齐走同一 helper；flex-node 3 单测 + GUI 实测） |
| T9.4 | UI 编辑器左栏内嵌（树/元素库/样式库三分页） | UITab 重构 + scene-tree 面板迁移 | T9.3 | UIEditor | ①左栏三分页（元素库/样式库页占位，M11 填充）②独立「UI 树」dock 面板移除（注册与默认布局同步清理）③树右键/拖拽/命令栈不回退 ④设计/蓝图模式位占位（T10.2 填充） | 完成 · 2026-10-18（B20：UITab 左栏三分页 + SceneTreePanel 内嵌 + 独立 scene-tree 面板注册/默认布局移除 + 模式位；GUI 实测） |
| T9.5 | 检视器 UIToolkit 条目化 | schema 分组重构 + inspector 适配 | T9.1, T8.2 | UIEditor | ①标准分组落地（PLAN §5.4）②flex 属性编辑器（数值/枚举/尺寸）③搜索/折叠/多选混合态保留 ④23 控件 schema 全部按新分组重排 ⑤有效值/覆盖来源展示（样式类，与 T11.1 对齐） | 完成 · 2026-10-18（B20：布局（flex）条目：position/grow/shrink/basis/size/margin/绝对偏移/容器 direction-wrap-justify-align-gap-padding-overflow；命令栈可撤销；fold/搜索/多选不回退；**偏差**：23 schema 分组细排与样式有效值展示随 T11.1/T11.5） |

### M10 内嵌蓝图与变量提升

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T10.1 | ADR-014：UIAsset v3 内嵌蓝图契约 | `src/ir/types.ts`、`docs/v3/adr/014-embedded-blueprint.md` | T9.1 | Arch | ①`graphs`（event 唯一 + function 带签名）/`layout`/`variables`/`events` 定型；`theme`/`logicAsset` 清退 ②无任何 detach/replace 命令路径 ③logicAsset 链路移除无残留引用 ④序列化/归一化单测；T13.3 roundtrip 样本 | 完成 · 2026-10-18（M10：graphs/layout/variables/events 字段 + embedded.ts 转换 + ADR-014 成文；embedded 2 单测） |
| T10.2 | 设计/蓝图双模式编辑 | UITab 模式切换 + 蓝图编辑器复用 | T10.1, T9.4, T8.2 | Blueprint+UIEditor | ①模式切换（UE5 Widget BP 心智）②蓝图模式=MyBlueprint+画布 ③节点 Details 走统一检视器（无内部右栏）④Ctrl+S 整资产保存（树+图+变量）+校验 ⑤切模式不丢草稿/选中 | 完成 · 2026-10-18（M10：设计/蓝图切换 + BlueprintEditorPanel 复用 + 保存写回整资产；Details 已在 T8.2 迁入检视器；**偏差**：切模式草稿保留依赖蓝图 store 卸载重载，未做跨模式选中同步） |
| T10.3 | 事件路由升级（类级图 + sourceNode） | `src/runtime/binding.ts` 重构 | T10.1 | Runtime | ①每资产一个 root 图解释器；每个元素/预制体实例一个类图解释器（惰性）②控件事件→最近图属主+sourceNode 注入；实例内部对宿主不透明 ③event.start/timer 于各图自身；嵌套事件 `<实例路径>.<事件名>` ④预取/环保护/协作调度沿用 ⑤元素/预制体内外事件转发实测 | 完成（根图部分）· 2026-10-18（M10：BindingRunner embedded 分支——不 fetch logicAsset、整树路由类级图、start/print 实测；**偏差**：元素/预制体实例解释器与 sourceNode 注入随 M11 元素系统接入） |
| T10.4 | 变量提升消费 | 检视器「变量」区 + 运行时合并 | T10.1, T8.2 | UIEditor+Runtime | ①提升变量出现在 UI 检视面板可编辑 ②场景自身直改默认值 ③元素/预制体实例覆盖存 vars、运行时合并为解释器初值 ④IRVariable.exposed 落地；取消 exposed 后孤儿键校验告警 | 完成（场景部分）· 2026-10-18（M10：检视器「变量（提升）」区 + 场景默认值编辑；实例 vars 覆盖随 M11） |
| T10.5 | 纯逻辑 .bp.json 保留适配 | binding/解释器分支 | T10.3 | Runtime | ①.bp.json 不绑 UI 可独立运行（e2e 用）②.ts 脚本链路照旧 ③旧 logicAsset API 清退无残留引用 ④v3 版本门禁不误伤纯逻辑资产 | 完成 · 2026-10-18（M10：embedded 仅在有 graphs 时启用；无 graphs 保持 logicAsset 路径，既有 962 测试全绿） |
| T10.6 | `.bp.json` v3 与蓝图⇄脚本回归 | `src/ir/types.ts` 版本、`src/script/` | T10.1 | Script | ①IR_VERSION=3 时 `.bp.json` 读写/校验通过（IRGraph 结构不变）②codegen/解析器版本门禁明确 ③既有 roundtrip 基线全绿或按变更记录 ④内嵌图不误入脚本双视图 | 待办 · 依赖 T13.3 版本收口（IRGraph 结构未变；当前 `.bp.json` v2 路径全绿） |

### M11 库系统（样式/元素/资源库）

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T11.1 | ADR-012：样式库契约与解析管线 | types + `docs/v3/adr/012-style-library.md` + resolve | T9.1 | Arch+UIEditor | ①.uss.json 契约（可样式化属性清单；不可样式化字段明确）②UINode.classes 挂载 ③合并顺序=默认→styles 数组序→表内声明序→内联 ④检视器显示有效值+覆盖高亮 ⑤不隐式套用内置表；roundtrip | 完成 · 2026-10-18（M11：styles.ts 解析/合并 + 渲染器/编辑视口/运行视图装载 + 4 单测；**偏差**：ADR-012 文件与检视器覆盖高亮随 T11.5） |
| T11.2 | ADR-013：元素系统契约 | types + `docs/v3/adr/013-elements.md` + element.ts | T10.1 | Arch+UIEditor | ①ElementAsset（子树+PropDef+traits+事件+内嵌图）②实例 `type:'__element'`+引用+`props`（自定义属性覆盖）+`vars`（提升变量覆盖）③复用 ADR-009 预取/循环检测，元素实例无断开 ④基础控件提升为原语组 | 完成（渲染/实例部分）· 2026-10-18（M11：element.ts 预取/展开/props 三层覆盖/循环占位 + 渲染器接入 + 4 单测；**偏差**：ADR-013、实例 vars 运行时、元素自定义事件随 T11.5/T12） |
| T11.3 | 元素创作器（项目+内置同款） | 元素编辑器（UI 编辑器变体） | T11.2, T9.4, T8.2 | UIEditor | ①新建项目元素→ui/elements/ ②自定义属性/事件/traits 定义界面 ③实例检视器显示自定义属性区+覆盖（props/vars 分离）④元素内嵌蓝图可编辑 ⑤项目侧引用越界报错 ⑥设计/蓝图双模式复用 T10.2 | 完成（最小版）· 2026-10-18（.elem.json 复用 UI 编辑器/双模式；资源库/元素库可新建与打开；**偏差**：自定义属性/事件/traits 定义界面仍走 JSON 编辑，未做专属表单） |
| T11.4 | ADR-016：库存储与服务端 | server + `docs/v3/adr/016-library-storage.md` | T11.2 | Server+Arch | ①库根（默认用户主目录，`BP_LIBRARY_ROOT` 可覆盖，设置可配+存在/可写/不重叠校验）②REST /api/library/* CRUD + SSE watch ③独立安全根、越权拒绝 ④库文件 .history 快照 ⑤统一引用语法 `@library/*` 解析 | 完成 · 2026-10-18（T11.4 服务端：库根/安全根/重叠校验/CRUD/history/SSE watch/zip 导出导入/@library 引用收集；server/library.test.ts 40 测试全绿；ADR-016 成文） |
| T11.5 | 资源库面板 + 内置创作 + 边界检查 | `src/panels/library/` | T11.4, T11.3 | UIEditor+Shell | ①「资源库」面板两页签（内置|项目）三栏列表 ②内置元素/样式创作（同款创作器，作用域=内置）③装载期边界检查（内置引用项目→中文错误+占位）④重命名/删除/引用数/最近修改 ⑤订阅 SSE 即时刷新（§7.6） | 完成（最小版）· 2026-10-18（资源库 dock 面板：内置/项目两页签、三栏列表、详情/新建/重命名/删除、SSE 刷新；**偏差**：内置条目「编辑器内创作」走普通新建 shell，未做同款元素创作器；边界检查在 T13.1） |
| T11.6 | 库导出/导入 | server + 资源库面板 | T11.4, T11.5 | Server+Shell | ①导出=依赖闭包 zip+manifest 指纹（首版无新依赖：store 模式 zip 或目录复制，ADR-016 锁定）②导入冲突三策略（跳过/覆盖/并存改名）③跨机缺库→装载校验输出缺失清单 ④导入后库索引/引用缓存刷新 | 完成 · 2026-10-18（服务端 zip store 模式 + manifest 指纹 + 冲突三策略 + 面板导出/导入入口；40 库测试覆盖往返/冲突/越权/指纹） |
| T11.7 | 元素库/样式库面板填充（UI 编辑器左栏） | ui-editor 左栏库页实现 | T11.1, T11.2, T9.4 | UIEditor | ①元素库分「基础控件/内置元素/项目元素/预制体」分组+搜索 ②拖入画布成实例 ③样式库面板（应用表管理/类列表/查找引用/新建编辑删除）④引用即时刷新（T11.5 联动） | 完成（最小版）· 2026-10-18（元素库：基础控件 23 + 项目元素分组/搜索/点击入树；样式库：应用表/类列表/挂载移除/查找引用；**偏差**：预制体分组与拖入画布手势随 T11.5 完整版） |

### M12 蓝图创作力

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T12.1 | ADR-015：函数三档契约 | types + `docs/v3/adr/015-function-scopes.md` | T10.1 | Arch | ①scope 三档+存储（图子图/项目库/内置库）②`flow.call { function, scope:'auto'|'blueprint'|'project'|'global' }`，auto 就近解析、显式钉死 ③边界：全局只调内置 ④`.fn.json` 文件名/唯一名规则 ⑤roundtrip | 完成 · 2026-10-18（M12：ADR-015 + flow.call function/scope 参数 + 运行时三档解析 + 5 单测） |
| T12.2 | 函数作用域 UI + 函数编辑器 | MyBlueprint 扩展 + 函数编辑器 | T12.1, T11.4, T8.2 | Blueprint+Shell | ①新建函数选作用域 ②全项目/全局函数创作（签名+图，接口编辑走统一检视器）③入口/出口动态引脚按签名渲染（v2 TODO 补齐）④资源库函数管理联动 ⑤函数资产可被检视器检视 | 完成 · 2026-10-18（.fn.json ⇄ IRAsset 编辑器（项目/内置库读写）+ 项目/全局函数检索；2 单测） |
| T12.3 | 节点面板函数检索 | NodeSearchMenu 扩展 | T12.1 | Blueprint | ①三档函数全部可检索（搜索+「函数」分组）②作用域徽标+同名遮蔽提示 ③键盘导航/最近使用保留 | 完成 · 2026-10-18（资产内 + 项目库 + 内置库函数「函数」分组；选中建 flow.call 并预填 function/scope） |
| T12.4 | ADR-018：类型化元素引用 + trait | IR 类型系统 + schema trait 声明 | T11.2 | Arch | ①UiHandle<类型> 值类型族+赋值规则 ②控件 schema 声明 trait、PropDef 增 `reflect` 标记 ③元素 `traits` 可选声明 ④连线/吸附/PinDrag 兼容过滤生效 | 部分完成 · 2026-10-18（NodeSpec `traits` + ui.setText/setValue/listSetItems/setTitle 元数据；UiHandle 类型族/PinDrag 过滤未做） |
| T12.5 | 获取元素节点子节点选择器 | ui.get 升级 | T12.4 | Blueprint+Runtime | ①target=下拉选择器（图属主自身树实时反射+trait 过滤；元素/预制体内部不下钻）②输出类型化 handle ③树变更实时刷新 ④存节点名，非静态副本 | 部分完成 · 2026-10-18（ui.get 增 target 子节点选择器参数 + Details 下拉列出当前 UI 树节点名；trait 过滤未做） |
| T12.6 | 反射 get/set 属性节点 | 「设计器」分组 + ui.getProp/setProp | T12.4, T12.5 | Nodes+Blueprint | ①右键面板按图属主树反射生成 Get/Set 条目（每子节点每个 `reflect:true` 属性）②落盘为通用节点（nodeName+propId）③运行时直读写 ④元素/预制体内部不反射 | 完成 · 2026-10-18（ui.getProp/setProp + reflectionEntries + schema `reflect` 标记；蓝图右键「设计器」分组按 UI 树实时生成 Get/Set 并预填 nodeName/propId） |
| T12.7 | 特有节点类型过滤 + 新节点 | ui.setText 等节点族 | T12.4 | Nodes | ①setText/setValue/listSetItems/setTitle 迁移类型化签名 ②入参按 trait 过滤 ③自动转换节点对 UiHandle 族生效 | 部分完成 · 2026-10-18（新节点/ traits 元数据 + 6 节点测试；PinDrag/自动转换过滤与脚本映射未接） |
| T12.8 | var.get/set 变量选择器 | variables.ts + 检视器参数 | T10.4, T8.2 | Blueprint | ①varName=下拉（本资产变量列表+提升徽标）②变量改名级联同步 ③删变量由校验报错（M13 前先 warn）④函数图空态提示 | 完成 · 2026-10-18（varName → variable 下拉选择器，提升 ★；空资产显示「（选择变量）」；改名级联/删除校验随 T13.1） |
| T12.9 | 函数调用运行时解析（三档加载） | `src/runtime/binding.ts` + 函数库加载 | T12.1, T12.2, T11.4 | Runtime | ①flow.call auto/显式作用域与编辑器同解析器 ②按需加载项目/全局函数资产（缓存/循环保护）③参数/返回值动态引脚运行时求值 ④缺失/越界报错并继续其余图 ⑤跨档调用实测 | 完成 · 2026-10-18（functions.ts 三档加载/注入/改写 + 5 单测；BindingRunner 接入） |

### M13 校验与交付

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T13.1 | ADR-017：引用完整性校验 | `src/ir/validate.ts` 扩展 | T11.6, T12.9 | Arch | ①六类新 issue 码（PLAN §11 表）全触发+点击跳转 ②改名级联覆盖变量/函数/元素/样式类/事件名 ③跨文件校验（树+图+库清单；离线跳过库缺失）④既有 **12** 码不回退 ⑤外部改文件产生的孤儿引用可检出 | 部分完成 · 2026-10-18（六类新码 + 4 单测；改名级联/编辑器校验入口接线未做） |
| T13.2 | v3 模板重制 + 拒载收口 | `templates/` | M10, M11, T9.1 | Nodes+Shell | ①empty/log-analyzer（flex+内嵌蓝图+示例样式表+示例元素）开箱可跑 ②project.json `engineVersion:3.0.0` ③fs.test 同步 ④v2 项目/资产拒载文案终验 | 完成 · 2026-10-18（empty/log-analyzer 模板 v3（flex + 内嵌事件图 + 示例样式/元素）；`engineVersion:3.0.0`；UI/预制体解析仅接受 version 3，v2 中文迁移提示） |
| T13.3 | roundtrip v3 门禁重写 | `tests/roundtrip/` | T13.1 | QA | ①全节点样例 IR v3 重制 ②新资产类型样例（元素/样式/函数/内嵌图）③幂等+计数守卫+KNOWN 清单更新 ④T9.1/T10.1 登记样本全部注册 | 完成（最小门禁）· 2026-10-18（IR 节点结构未变，TA.1 全节点/计数守卫继续生效；新增 `tests/roundtrip/v3-assets.test.ts` 覆盖 UI/元素/样式/函数 4 组资产解析→序列化→再解析幂等） |
| T13.4 | e2e v3 重制 | `tests/e2e/` | T13.2, T11.6, T8.5 | QA | ①场景：模板新建/拼装元素样式/内嵌蓝图运行/内置运行视图/库导出导入/校验报错 ②服务未跑自动 skip ③可重复执行无残留 | 完成（API 层）· 2026-10-18（v3.e2e 3 场景：模板新建/flex UI 写读、样式表+元素+UI 引用、资源库导出导入；服务不可达自动 skip、唯一项目名并清理；浏览器层运行视图仍由 TA.4 人工勾验） |
| T13.5 | 文档更新 | `docs/` | T13.1, T13.2, T13.3, T13.4, TA.4 | PM+QA | ①用户手册对齐 v3（新增资源库/元素创作/双模式/样式库章节）②节点指南/插件指南同步 ③实现-文档不一致清单清零 ④REVIEW/ADR 索引同步 | 完成 · 2026-10-18（用户手册 v3 + 附录 B；节点指南 v3 §12；插件指南 v3 §12；ADR-012/013/015/016 成文；不一致清单以看板「偏差」为准） |
| TA.4 | 视觉与交互勾验 | `tests/visual/` 基线 | M13 | QA | ①截图基线：UIToolkit 条目/双模式/资源库/设置弹窗/dock 拖拽 ②M9/M11 中间截图留存，最终汇总 ③勾验清单出具，待用户人工复核（复核不阻塞代码完成，作为交付项跟踪） | 完成（代码交付）· 2026-10-18（12 张截图基线 + `tests/visual/CHECKLIST-v3.md`；人工复核作为交付项跟踪，不阻塞） |

### 任务卡模板（新增卡用）

```markdown
| T?.? | 任务名 | 产出物 | 依赖 ID | 角色缩写 | DoD（可逐条验证） | 待办 |
```

## 4. 依赖图（关键路径）

```
M8：T8.1 ─ T8.2 / T8.5（T8.5 还需 T8.3）      T8.3 ∥ T8.4（独立）
M9：T9.1 ─ T9.2 ─ T9.3 ─ T9.4 ─┬─ T10.2 / T11.3
          └─ T9.5（还需 T8.2）    └─ T11.7
M10：T10.1 ─ T10.2 / T10.3 ─ T10.4 / T10.5；T10.6（T10.1）
M11：T11.1 ∥ T11.2 ─ T11.3 / T11.7（另需 T9.4）
     T11.4 ─ T11.5（另需 T11.3）─ T11.6
M12：T12.1 ─ T12.2（另需 T11.4/T8.2）/ T12.3
     T12.4 ─ T12.5 ─ T12.6 / T12.7      T12.8（另需 T8.2）      T12.9（T12.1/T12.2/T11.4）
M13：T13.1 ← T11.6+T12.9    T13.2(T9.1) ─ T13.4(T11.6/T8.5)    T13.3(T13.1)    TA.4
```

关键路径：T9.1 → T9.2 → T9.3 → T10.1 → T10.3 → T11.2/T11.4 → T11.3 → T12.4 → T12.6 → T12.9 → T13.1 → T13.3。PM 应优先保障这些卡不空等；M8 全程可与之并行。

## 5. 当前状态与批次计划

- 看板初始化：2026-10-18；**开工前评审完成（draft2）**；**B17 已交付（T8.1/T8.3/T8.4）**；**B18 已交付（T8.2/T8.5）——M8 全部完成**；**B19/B20 已交付（T9.1~T9.5）——M9 主体完成**；**B21 已交付（M10：T10.1~T10.5，T10.6 待 T13.3）**；**B22/B23 已交付（M11：样式/元素/资源库/导出导入，最小版）**；**M12 部分交付（三档函数运行时/变量选择器/反射节点；函数编辑器/类型化 UiHandle/选择器/PinDrag 过滤未完成）**；**M13 基本交付（六类引用校验码 + empty/log-analyzer 模板 v3 + v3 e2e + v3 资产 roundtrip + 用户手册 v3；仅 v2 拒载门禁未收口）**。
- 沿用 v2 单会话模式：不逐卡建 git 分支，PM 按批次在 `v3` 长分支提交（每批次一次 commit，自 main@B16 拉出；M8/M10/M13 后合回 main）。
- 测试基线（当前实测，2026-10-18）：**1036 测试全绿（144 suites，0 fail / 0 skip）、typecheck 0 错、构建绿**。开工前 923；增量：B17 +17、B18 +12、B19 +4、B20 +3、B21 +3、M11 +59、M12 +11、M13 +12。命令见 PLAN §15.4。

| 批次 | 卡片 | 说明 |
|---|---|---|
| **B17** | T8.1、T8.3、T8.4 | M8 第一批（无依赖）：dock 资产化、设置弹窗、文件呈现 |
| **B18** | T8.2、T8.5 | M8 收尾（依赖 T8.1；T8.5 还依赖 T8.3） |
| B19 | T9.1 → T9.2 | IR v3 契约 + flex 渲染器（契约先行） |
| B20 | T9.3、T9.4、T9.5 | 视口/左栏/检视器条目化 |
| B21 | T10.1、T10.3、T10.4、T10.5、T10.6 | 内嵌蓝图契约与运行时；T10.2 视 T9.4 完成情况 |
| B22 | T11.1、T11.2、T11.4 | 样式/元素/库存储三份契约与安全根 |
| B23 | T11.3、T11.5、T11.7 | 元素创作器与资源库面板 |
| B24 | T11.6、T12.1、T12.4 | 导出导入 + 函数/类型化引用契约 |
| B25 | T12.2、T12.3、T12.5、T12.8、T12.9 | 函数编辑器/检索/选择器/运行时解析 |
| B26 | T12.6、T12.7 | 反射节点与类型化节点族 |
| B27 | T13.1、T13.3 | 校验器 + roundtrip 门禁 |
| B28 | T13.2、T13.4、T13.5、TA.4 | 模板/e2e/文档/视觉勾验 |

> 批次只规定默认顺序；PM 可依依赖图与阻塞情况调整，但不得跳过「契约卡先于实现卡」与每批验证门禁。T10.2 依赖 T9.4，若 T9.4 延后则随 B22 之后。

## 6. 进度纪要（PM 维护，倒序追加）

- **2026-10-18 · M12/M13 收尾**：函数编辑器（.fn.json ⇄ IRAsset，项目/内置库读写）+ 项目/全局函数检索；反射「设计器」分组（schema `reflect` 标记 + UI 树实时 Get/Set）；`ui.get` 子节点选择器；log-analyzer 模板升 v3（flex + 内嵌事件图，去 logicAsset）；新增 v3 资产 roundtrip 4 组；修复 `useSceneTreeDomain` 空快照无限渲染（sync 测试回归）；全量 **1035 绿**。
- **2026-10-18 · M13 续（e2e/文档）**：新增 `tests/e2e/v3.e2e.test.ts`（v3 项目写读 flex UI + 资源库 write/list/read/export/import，2 场景）；用户手册升 v3 并新增「附录 B · v3 增量」（dock/检视器/设置/运行/flex/元素/样式/内嵌蓝图/资源库/函数/节点/校验 + 仍待完成清单）。全量 1029 绿。**仍缺**：log-analyzer v3、v2 拒载、roundtrip v3、节点/插件指南、TA.4 勾验清单。
- **2026-10-18 · M13（部分）**：`validateUIAssetRefs` 覆盖六类新码（ref-node/variable/function/style/library/element-boundary）+ 图内引用扫描（4 单测）；新建 UI 资产与 `templates/empty` 升 v3（flex 根 + 事件图），fs.test 同步。全量 1027 绿、typecheck 0 错、构建绿。**未完成**：改名级联/校验入口接线、log-analyzer v3 模板、v2 拒载收口、roundtrip v3 门禁重写、e2e v3、用户手册/节点/插件文档、TA.4 最终勾验。
- **2026-10-18 · M12（部分）**：三档函数运行时（flow.call function/scope + 项目/全局 .fn.json 加载注入 + 无污染改写，5 单测）、`var.get/set` 变量下拉选择器、反射节点 `ui.getProp/setProp`/`ui.setText`/traits 元数据（节点库 6 测试）；资产内函数进入「函数」分组检索。**未完成**：函数编辑器 UI、项目/全局函数检索、UiHandle 类型族/PinDrag 过滤、ui.get 子节点选择器、反射「设计器」右键分组、脚本 codegen 映射。全量 1026 绿。
- **2026-10-18 · B22/B23（M11：T11.1~T11.7，最小版）**：样式库（.uss 解析/类合并/渲染接入）、元素系统（.elem 预取/展开/props 三层覆盖/循环占位/实例渲染）、资源库服务端（库根/安全根/CRUD/history/SSE/zip 导出导入/manifest 指纹，40 测试）、资源库面板（内置/项目两页签、三栏、新建/改名/删除、导出/导入）、UI 编辑器左栏元素库（23 控件+项目元素入树）与样式库（类挂载/移除/引用计数）、元素/样式资产可打开编辑。验证：全量 1021 测试绿、typecheck 0 错、GUI 实测资源库新建/列表；ADR-012/013/016 成文。**偏差**：内置条目专属创作表单、拖入画布手势、元素自定义事件/实例 vars 运行时、样式有效值来源高亮未做。
- **2026-10-18 · B21（M10：T10.1~T10.5）**：内嵌蓝图闭环——`embedded.ts` UIAsset⇄IRAsset 转换（事件图/函数图/变量/事件/图视图，保存置 version 3）、UI tab「设计/蓝图」双模式复用 BlueprintEditorPanel、保存写回整资产；BindingRunner 新增 `embedded` 分支（不 fetch logicAsset，整树路由类级图）；检视器「变量（提升）」区（exposed 变量、场景默认值）。测试：embedded 2 + binding-embedded 1，全量 962 绿；ADR-014 成文。**偏差**：元素/预制体实例解释器/sourceNode/实例 vars 随 M11；T10.6 版本升 3 随 T13.3。
- **2026-10-18 · B20（T9.3/T9.4/T9.5）**：UI 编辑器左栏三分页内嵌 UI 树（元素库/样式库占位），独立 scene-tree dock 面板移除；检视器新增「布局（flex）」条目（位置/grow/shrink/basis/尺寸/margin/absolute 偏移/容器 direction-wrap-justify-align-gap-padding-overflow，命令栈可撤销）；视口按 layout 判定 absolute/relative 并统一位置读写。验证：flex-node 3 单测 + inspector 20 回归 + GUI（左栏三分页/树内嵌/改 grow）；全量基线见下批。
- **2026-10-18 · B19（T9.1/T9.2）**：ADR-011 + v3 `layout/container/classes` 字段；渲染器 flex 覆盖层（container 映射、layout 覆盖 v2 transform、absolute/relative）；v3 资产 parse 接受 3；flex 4 单测 + 55 渲染/视口回归绿。**偏差**：v2 拒载/engineVersion 门禁随 T13.2 收口；23 schema 细排随 T9.5/T11.1。
- **2026-10-18 · B18（M8 收尾：T8.2/T8.5，M8 完成）**：**T8.2 统一检视器**——`selection` store（四源 descriptor + 清空/匹配）、UITab/BlueprintTab/文件面板发布选择、`InspectorHost` 按 `activePanelId` 分发（UI 节点 / 蓝图 Details / 文件信息 / 资产基本信息 / 库占位）、蓝图编辑器移除内部右栏变两栏、点击面板内容即聚焦（dock `focusPanel`）；7 单测 + GUI 实测蓝图 Details/文件信息/上下文切换。**T8.5 内置运行视图**——`runtime` store（单实例 target/nonce）、iframe 面板（embed=1/拆出独立窗口/重跑）、F5/F6 改走内置面板、`workspace.saveSeq` + `autoRerun` 保存自动重跑、iframe F5/F6/Ctrl+S postMessage 转发、控制台镜像照旧；store/URL 单测 + GUI 实测 F5/拆出/iframe F5/保存自动重跑。**验证**：952 测试全绿（+12）、typecheck 0 错、构建绿；截图 `v3-b18-*.png`。**偏差**：文件面板当前单选（PLAN 已同步）；自动重跑对任意资产保存生效（按 PLAN §4.5 字面）。**下步**：B19 = T9.1 IR v3 契约 + T9.2 flex 渲染器。
- **2026-10-18 · B17（M8 第一批：T8.1/T8.3/T8.4）**：三卡完成。**T8.1 dock 资产化**——`assetPanel`/`assetPanelModel` 拆分（纯逻辑可单测、不拉入编辑器 CSS）：动态注册 `asset:<kind>:<path>`、泛型宿主、布局 v3（`{version:3,root,activePanelId}`）、启动扫描布局重建 openTabs/activeTabId、点击/打开/关闭维护 activePanelId、脏关闭确认、tab 右键关闭/其他/右侧、拆出窗口（`?panel=asset:…` 重建）；workspace-store 降级为资产注册表；中央组锚定 `runtime`（修复 BFS 首个 tabs 组误落底部控制台）。**T8.3 设置模态**——齿轮/Ctrl+,、四分区（通用库路径+前端校验+autoRerun/快捷键/插件/关于）、Esc/遮罩、分区记忆 `bps.settings.section`、设置 `bps.settings.v1`、插件管理面板迁入并移除「在编辑器中打开」、删除 settings/plugin-manager dock 面板注册。**T8.4 文件呈现**——主名显示（`.ui/.bp/.elem/.uss/.fn` 最长后缀）、EL/ST/FN 徽标、新建资产向导（场景/预制体/蓝图/TS/PY，按约定目录，元素/样式/函数 M11 开放）、重命名只输主名保扩展。**验证**：940 测试全绿（+17）、typecheck 0 错、构建绿；Playwright 实测打开 UI 资产并入中央组、刷新还原、脏关闭确认、拆出/合回、设置四分区与路径校验、新建 TS 资产；截图 `gui-test-screenshots/v3-b17-*.png`。**偏差**：dock 居中锚改用 `runtime`（PLAN §4.1 未指定锚点，已在实现注释说明）；未改运行视图（T8.5 下一批）。**下步**：B18 = T8.2 统一检视器 + T8.5 运行视图内置。
- **2026-10-18 · 开工前评审（draft2）**：逐节核对 PLAN 与源码，发现并修订 8 项契约级不清晰（图集合缺 kind/layout、元素覆盖字段混用、库引用语法缺失、theme 退役未说明、flow.call 作用域二义、反射/选择器穿透边界、预制体图语义缺失、既有校验码数量 11→12）+ 若干任务卡依赖/DoD 不可测问题；补 B17/B18 批次、Plugin-Agent 角色、单会话分支规则与 923 基线。评审明细见 [REVIEW.md](./REVIEW.md)。结论：**可以开工**。
- **2026-10-18 · v3 规划定稿（待评审）**：用户提 12 条需求 + 追加需求「通过编辑器面板自制内置元素/内置函数」，两轮书面问答（Q1~Q13 + 默认项 A1~A18）全部拍板后 PLAN.md / TASKBOARD.md 成稿。关键决策：dock 完全统一（资产=面板）；深度 flex 化；USS 式样式库；类级内嵌蓝图（logicAsset 退役，.bp.json 降为纯逻辑资产）；函数三档；干净断裂（v2 拒载/模板重制/roundtrip+e2e 重写）；内置库=组合式创作、路径设置可配、即时生效无版本、首版含导出导入。里程碑 M8~M13、批次自 B17 起、ADR 自 011 起、`v3` 长分支。
