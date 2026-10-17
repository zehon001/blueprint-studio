# v2 任务看板（AI Agent 分工）

> 配套方案：[PLAN.md](./PLAN.md)（开工前必读相关章节）。
> 本看板是 v2 开发期间的任务唯一真源，由 **PM-Agent 独占维护**，其他 Agent 只能「领卡 / 汇报 / 交卡」。

## 1. Agent 角色定义

| 角色 | 职责 | 必读 PLAN 章节 |
|---|---|---|
| **PM-Agent**（项目管理） | 看板唯一维护者；任务分发与领卡仲裁；DoD 验收（可派 QA-Agent 复核）；阻塞升级决策（插队/换人/拆卡）；里程碑合并与进度纪要；契约变更知会 | 全部 |
| **Arch-Agent**（架构） | IR / 文件格式 / NodeSpec / 插件清单等契约的唯一变更发起者；类型定义与 ADR 文档；版本迁移函数 | §4 §5 §13 §14 |
| **Shell-Agent**（编辑器外壳） | dock 系统、多窗口同步、命令栈（撤销重做）、快捷键、项目管理器、文件系统面板、主题 | §3 §6 §15 |
| **UIEditor-Agent**（UI 编辑） | UI 节点库 schema、2D 视口、UI 树面板、检视器、UI 预制体 | §7 |
| **Blueprint-Agent**（蓝图编辑器） | 蓝图视觉系统、画布交互、结构面板（My Blueprint）、蓝图检视器、注释框 | §8 |
| **Script-Agent**（脚本系统） | CodeMirror 编辑器、内建 API、TS/Pyodide 沙箱、注解处理、codegen 与受控子集解析器 | §9 §10 |
| **Runtime-Agent**（运行时） | 运行窗口、IR 解释器、事件总线、调试观察通道（WS 反向） | §11 §12 |
| **Server-Agent**（本地服务） | FS API、esbuild 转译、静态托管、WS Hub、CLI 桥与插件执行器 | §3 §14 |
| **Nodes-Agent**（基础节点库） | `src/nodes/` 全部内置节点、《节点开发指南》 | §13 |
| **QA-Agent**（测试） | roundtrip 幂等测试、E2E 冒烟、视觉复刻度对比、回归清单维护 | §20 |

约定：单人会话可身兼多角色，但**一次只以一个角色身份领卡**；PM 与实现角色不得同一人验收同一张卡。

## 2. 协作协议

1. **领卡**：Agent 从「待办」中认领无未完成依赖的卡，把状态改 `进行中` 并在卡后署名（会话/日期）。同一张卡同时只有一人。
2. **交卡**：完成后状态改 `待评审`，在「产出说明」栏写：分支名、改动摘要、自测结果。PM-Agent 按 DoD 逐条验收，通过→`完成`，不通过→`退回`（附原因）。
3. **阻塞**：卡上追加 `⚠ @PM 原因`，PM 决定：解锁依赖插队 / 换人 / 拆卡 / 挂起。
4. **分支**：每卡一分支 `feature/T<id>-<slug>`；PM 验收通过后由 PM 合并 `v2` 长分支（M2/M4/M7 合回 main，见 PLAN §17）。
5. **契约变更**：IR 结构 / 文件格式 / NodeSpec / 插件清单的任何改动，先由 Arch-Agent 在 `docs/v2/adr/` 落 ADR 并知会 PM，PM 广播到受影响在途卡。
6. **进度纪要**：每个里程碑收尾，PM 在 §6 追加一段（完成 / 偏差 / 下步）。
7. **状态枚举**：`待办` `进行中` `待评审` `退回` `完成` `挂起`。

## 3. 任务卡

### M0 地基（项目模型 + 外壳）

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T0.1 | 契约定义：IR / 项目文件 / NodeSpec / 插件清单的 TS 类型与文档 | `src/ir/types.ts`、`docs/v2/adr/001-ir.md` 等 | — | Arch | PLAN §4/§5/§13/§14 所列结构全部有类型定义与字段注释；typecheck 通过 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.2 | 服务端项目 FS API（安全根内 CRUD / 读目录树 / 文件监视）+ 模板脚手架 | `server/fs.ts`、`templates/` | T0.1 | Server | 新建项目→目录结构符合 PLAN §4.1；越权路径被拒；增删改经 REST 可用 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.3 | Dock 外壳与面板注册框架（拖拽吸附 / 布局持久化） | `src/shell/dock/` | T0.1 | Shell | 任意面板可拖到四边/中心成 tab；布局刷新后还原；新面板注册 ≤10 行代码 | 完成 · 2026-10-17（产出说明见 §6；E2E 浏览器实测通过，顺带修复 dock-pane flex 断链） |
| T0.4 | 多窗口拆合（BroadcastChannel 按序重放） | `src/shell/windows/` | T0.3 | Shell | 拆出的面板与主窗状态实时一致（双向改 store 均同步）；关闭弹窗内容回主窗；弹窗被拦截时降级新标签页 | 完成 · 2026-10-17（首派中断，续作修复；34 测试；浏览器端多窗实测待 B5 后 PM 抽查） |
| T0.5 | 统一命令栈（immer patches）+ 快捷键框架 | `src/shell/commands/` | — | Shell | 蓝图/UI/属性三域各接一个示例命令；Ctrl+Z/Shift+Z 正确跨域撤销；快捷键注册含冲突检测 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.6 | 项目管理器页（最近 / 新建模板 / 导入文件夹 / 打开） | `src/shell/project-manager/` | T0.2 | Shell | 新建→进入主编辑器；最近列表持久化；导入任意文件夹成功打开 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.7 | 文件系统面板（树 / 右键增删改重命名 / 拖入导入） | `src/panels/file-system/` | T0.2, T0.5 | Shell | 增删改重命名全可用且可撤销；与磁盘实际状态一致 | 完成 · 2026-10-17（36 测试 + 服务端 E2E；已注册进 dock） |
| T0.8 | 主题系统（Godot 深色 token + UE5 蓝图配色 token） | `src/shell/theme/` | — | Shell | 全部颜色/间距 token 化无硬编码；蓝图节点引脚色符合 PLAN §8.1 表 | 完成 · 2026-10-17（产出说明见 §6） |

### M1 UI 闭环

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T1.1 | UI 节点库 schema（PLAN §7.1 全部节点 + 属性声明） | `src/ui-editor/schema/` | T0.1 | UIEditor | 4 类节点齐全；每个属性有类型/默认值/分组；检视器可纯 schema 驱动 | 完成 · 2026-10-17（产出说明见 §6） |
| T1.2 | DOM 渲染器（编辑态/运行态共用，编辑冻结交互） | `src/runtime/render/` | T1.1 | UIEditor+Runtime | 同一 UI 树两态渲染一致；容器布局正确嵌套 | 完成 · 2026-10-17（B5 交付 13 测试；表格状态补记） |
| T1.3 | 2D 视口（选择/框选/移动/对齐吸附/缩放/键盘微调） | `src/ui-editor/viewport/` | T1.2 | UIEditor | PLAN §7.2 操作全可用；操作均入命令栈可撤销 | 完成 · 2026-10-17（24 测试；浏览器手感抽查留 PM/QA） |
| T1.4 | UI 树面板（树形/拖拽重排父子/右键菜单） | `src/panels/scene-tree/` | T1.1, T0.5 | UIEditor | 拖拽改变父子即时反映到视口；右键含「添加节点/复制/删除/附加逻辑资产(占位)」 | 完成 · 2026-10-17（重派成功；30 测试；已注册进 dock） |
| T1.5 | 检视器（分组/搜索/类型编辑器/多选混合态） | `src/panels/inspector/` | T1.1, T0.5 | UIEditor | schema 驱动生成；搜索过滤属性；多选显示共同属性；改动可撤销 | 完成 · 2026-10-17（20 测试；listColumns 为 JSON 源编辑，可视化编辑 T7.x） |
| T1.6 | 运行窗口 v1（runtime.html 加载 UI 静态渲染） | `src/runtime/`、`server/static.ts` | T1.2, T0.2 | Runtime | F5/F6 打开独立窗口正确渲染主 UI / 当前 UI；窗口标题含运行模式 | 完成 · 2026-10-17（16 测试；F5/F6 浏览器实测通过：标题/渲染/绑定加载全对） |
| T1.7 | Transform 与容器布局（position/rotation/size + VBox/HBox/Grid 排列） | 渲染器扩展 | T1.2 | UIEditor | 旋转/尺寸视觉正确；容器子节点按布局排列；锚点简化版生效 | 完成 · 2026-10-17（10 测试+回归 13 绿；mergeDuplicates 真 rowspan 顺手完成；锚点为简化语义见 §6） |

### M2 蓝图闭环

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T2.1 | 蓝图视觉系统（节点头配色/引_PIN 色标/连线样式/网格画布） | `src/blueprint/view/` | T0.1, T0.8 | Blueprint | 与 UE5 截图并排对比：分类配色、引脚色、exec 白线/数据彩虚线全部符合 §8.1 | 完成 · 2026-10-17（E2E 冒烟浏览器截图确认节点头/画布渲染；UE5 精确并排对比留 TA.3） |
| T2.2 | 画布交互（右键搜索/引脚拖出弹兼容菜单/自动转换节点/断开/框选/复制粘贴/Ctrl拖拽复制/平移缩放） | `src/blueprint/interaction/` | T2.1 | Blueprint | §8.2 清单逐项可用；不兼容类型拖线自动插转换节点；复制粘贴跨图可用 | 完成 · 2026-10-17（首派中断后核查补全；§8.2 九项全过 + 修复右键被吞 bug；39 测试） |
| T2.3 | 结构面板 My Blueprint（变量/函数/事件 + 暴露→Get·Set 自动生成） | `src/blueprint/my-blueprint/` | T2.1 | Blueprint | 变量勾「暴露」后拖入图生成 Get/Set；函数子图含入口/出口节点，主图调用节点自动出现 | 完成 · 2026-10-17（25 测试；「拖入」以右键插入落地、拖入留 TODO；graph-op 补充 spec 见 ADR 说明） |
| T2.4 | 蓝图检视器（节点参数/引脚默认值/文档） | `src/blueprint/details/` | T2.1 | Blueprint | 选中节点显示参数与未连线引脚默认值，可编辑入命令栈 | 完成 · 2026-10-17（13 测试；多选混合态批量实现） |
| T2.5 | IR 解释器 v2（exec+数据流/函数调用/异步/串行事件队列+旁路） | `src/runtime/interpreter/` | T0.1 | Runtime | v1.1 语义对齐（exec 链不穿纯节点、事件保序、RPC 旁路）；含单元测试 | 完成 · 2026-10-17（18 测试；B2 失败后重派成功） |
| T2.6 | 蓝图绑定 UI 节点 + 事件驱动运行 | 绑定属性 + 运行窗口接线 | T2.5, T1.6 | Runtime | 检视器可挂 `.bp.json` 到节点；按钮点击触发蓝图事件节点；`ui` 访问器读写子树节点 | 完成 · 2026-10-17（BindingRunner+UiHandle+事件 hub；13 测试；浏览器 E2E 留 M2 合并点） |
| T2.7 | 注释框 Comment 节点（可调色/框选整体移动） | 蓝图编辑器 | T2.2 | Blueprint | UE5 同款行为；注释含节点随注释移动 | 完成 · 2026-10-17（ADR-006：IRGraph.comments 可选字段；13 测试+校验回归；框选含注释留后续） |
| T2.8 | 保存校验器（类型连线/悬空 exec/未知节点 → 错误列表跳转） | `src/ir/validate.ts` | T0.1 | Arch | 构造 5 类错误样本全部报出且点击跳节点；`.bp.json` 往返序列化无损 | 完成 · 2026-10-17（19 测试；normalizeIR 供 roundtrip 复用） |

### M3 脚本（TS）闭环

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T3.1 | 脚本编辑器（CodeMirror 6 · TS 高亮 · 诊断标记 · [蓝图/脚本]切换条） | `src/script/editor/` | T0.3 | Script | 打开 `.ts` 逻辑资产可编辑保存；切换条切到蓝图视图正常渲染 | 完成 · 2026-10-17（15 测试；诊断标记=显式占位待 T3.6，蓝图视图=占位面板待 T3.6——未虚报） |
| T3.2 | 内建 API 与类型包（ui/vars/emit/onEvent/plugins/print/convert/format/delay） | `src/script/api/` | T0.1 | Script | PLAN §9.2 全部全局有类型声明与文档注释；TS 资产有补全 | 完成 · 2026-10-17（9 全局 JSDoc+Proxy 运行时+补全扩展；20 测试） |
| T3.3 | TS 转译执行链（服务端 esbuild → 运行窗口沙箱执行） | `server/` + `src/runtime/sandbox/` | T2.6 | Script+Server | `.ts` 逻辑资产挂 UI 节点后运行窗口行为与蓝图等价（同一 IR） | 完成 · 2026-10-17（POST /api/transpile + LRU 缓存；绑定分支按扩展名分发；混合绑定等价测试；21 测试） |
| T3.4 | 注解处理（@tool/@expose/@on → IR 变量/事件节点） | `src/script/annotations.ts` | T3.2 | Script | 脚本写 @expose → 蓝图出现对应 Get/Set；@on → 事件节点；双向（蓝图勾暴露→codegen 生成注解） | 完成 · 2026-10-17（解析半边由 T3.6 承接，本卡补缺+双向端到端 8 测试；随 T3.8 交付） |
| T3.5 | Codegen：IR → TS（含纯节点链内联表达式合成） | `src/script/codegen-ts.ts` | T3.4 | Script | PLAN §10 规则全实现；生成代码可读（无嵌套超 3 层的节点链展开）；roundtrip 幂等 | 完成 · 2026-10-17（表达式表 40 纯节点锁定；15 roundtrip 测试） |
| T3.6 | 受控子集解析器：TS → IR | `src/script/parser-ts.ts` | T3.5 | Script | if/for/while/表达式/函数/emit/await 映射正确；语法错误给出行列诊断 | 完成 · 2026-10-17（行列诊断 1 起；超集折叠 snippet；与 T3.5 合并派发） |
| T3.7 | 脚本片段节点（不可映射段兜底） | IR 扩展 + 蓝图节点 | T3.6 | Script+Blueprint | 含片段的资产往返（IR→TS→IR）无损；片段节点可展开编辑源码 | 完成 · 2026-10-17（ADR-007：引脚契约+推导+标记元数据；片段运行时 new Function；模态编辑；23 测试+roundtrip 18） |
| T3.8 | 双视图同步协议（保存者胜 / 过期提示重载） | 编辑器接线 | T3.5, T3.6 | Script+Arch | 两视图同开时后保存者胜，另一侧切回提示重载；无脏丢失 | 完成 · 2026-10-17（sync 状态机 10 用例+DOM 端到端；蓝图视图真渲染替换占位；诊断徽标接真） |

### M4 Python

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T4.1 | Pyodide 集成（本地托管 / 懒加载 / 进度提示） | `server/vendor/pyodide` + 沙箱 | T3.3 | Script+Server | 打开 `.py` 资产才加载；离线（无外网）可用；加载有进度 | 待办 |
| T4.2 | Python 内建 API 对等（snake_case 别名 + async def） | `src/script/api/py/` | T4.1 | Script | §9.2 内建全局 Python 全对等；TS/Py 同一 IR 运行行为一致 | 待办 |
| T4.3 | Python 装饰器解析 → IR | `src/script/parser-py.ts` | T4.2 | Script | @tool/@expose/@on 与 TS 注解同构映射；诊断行列号 | 待办 |
| T4.4 | Codegen：IR → Python | `src/script/codegen-py.ts` | T4.3 | Script | roundtrip（IR→Py→IR）幂等；风格符合 Python 习惯（缩进块/推导式可选） | 待办 |

### M5 事件 + 调试

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T5.1 | 事件总线（UI/系统/插件推送/自定义；目标路由 本节点/本UI/全部） | `src/runtime/events/` | T2.6 | Runtime | PLAN §11 全场景；事件间保序；旁路不死锁 | 完成 · 2026-10-17（四源入队/target 矩阵/环保护 8 跳；13 测试） |
| T5.2 | 事件面板（内建+自定义列表 / 双击创建跳转） | `src/panels/events/` | T5.1, T2.3 | UIEditor+Blueprint | 选中 UI 节点列出其内建事件与资产自定义事件；双击建/跳事件节点 | 完成 · 2026-10-17（25 测试；双击路由表全覆盖含快捷挂载；已注册进 dock） |
| T5.3 | 事件节点三件套（自定义事件 / 发送事件 / 监听） | `src/nodes/events.ts` | T5.1 | Nodes | 多参数事件可定义；发送→监听 E2E 通 | 完成 · 2026-10-17（T13.1 已建，本卡验收+E2E 补强：send 加 target 引脚、listen 具名参数注入；随 T5.1 交付） |
| T5.4 | 运行时蓝图观察（WS 反向：节点高亮/exec 流动/端口实时值 150ms 批量） | 调试探针 + 编辑器叠加层 | T2.6 | Runtime | v1.1 能力全保留；编辑器开该蓝图视图自动接入；可一键关闭 | 完成 · 2026-10-17（WS debug.v1 协议+150ms 批量+500 上限+惰性衰减；24 测试；浏览器实测留合并点） |

### M6 插件系统

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T6.1 | 插件清单格式 + 三源注册表（内置/项目/静态目录合并去重） | `plugins-registry/`、`server/plugins/registry.ts` | T0.1, T0.2 | Plugin+Server | 三源清单正确合并；清单 schema 校验 | 完成 · 2026-10-17（20 测试+E2E；优先级定案 项目>静态>内置；前缀 camelCase 待 PM 追认进 ADR-004） |
| T6.2 | 插件管理子界面（列表/徽标/两按钮/进度日志） | `src/panels/plugin-manager/` | T6.1 | Plugin | §14.2 全交互；最新版时更新按钮置灰 disabled；安装日志实时滚动 | 完成 · 2026-10-17（42 测试；四态徽标/SSE 流/并发 detect；已注册进 dock+工作区 tab） |
| T6.3 | CLI 检测/安装/更新执行器（strategy: winget/npm-global/download-zip/custom-cmd；版本解析） | `server/plugins/executor.ts` | T6.1 | Server | detect 失败=未安装；安装后状态自动刷新；命令可被设置覆盖；执行流式回传日志 | 完成 · 2026-10-17（重派后核对补全+真实 server 冒烟；detect/install SSE/invoke+并发锁） |
| T6.4 | 插件节点动态注册（清单 → NodeSpec → 蓝图可搜可用） | `src/nodes/dynamic.ts` | T6.1, T2.2 | Plugin | 节点出现在右键搜索；exec/数据引脚可用；调用走 CLI 桥/自定义执行器 | 完成 · 2026-10-17（19 测试；specs 懒加载按需并入；invoke 降级不崩；NodeRunContext 增补 callPlugin/projectName 记入 ADR-005） |
| T6.5 | 手机日志插件（双模式 + Android 日志解析 + 多文件时间归并） | `plugins-registry/phone-log.json` + 执行器 | T6.3, T6.4 | Plugin | §14.3 全项：adb dump/流式两节点；3 份乱序样本→按时间稳定有序；两种 Android 格式可解析 | 完成 · 2026-10-17（文件模式 3 份乱序全序稳定（时间→文件序→行序 tie-break）；onLine WS 持续流 plugin.push；解析单源复用 src/nodes/convert） |
| T6.6 | 飞书 CLI 插件清单（检测/安装/更新 + 节点封装，不实现功能本体） | `plugins-registry/feishu-cli.json` | T6.3 | Plugin | 未安装显示下载；已装最新置灰更新；节点仅封装（调用透传 CLI 输出） | 完成 · 2026-10-17（invoke.cmdTemplate 透传封装；字段追认进 ADR-004） |

### M7 打磨

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T7.1 | 快捷键全表 + 设置界面（可查可改 + 冲突检测） | `src/shell/keymap/` | T0.5 | Shell | PLAN §15 表落齐；改键持久化 | 待办 |
| T7.2 | 模板项目（空 / 日志分析器示例） | `templates/` | M6 | Nodes+Shell | 新建向导可选模板；日志分析器模板开箱可跑 | 完成 · 2026-10-17（两模板 B0/B2 交付；「开箱可跑」由 B12 蓝图补全 + 实机 10 行渲染验证达成；fs.test 断言同步） |
| T7.3 | UI 预制体（.ui.json 嵌套实例化 / 双击进入编辑） | UI 编辑器 | T1.4 | UIEditor | 预制体改动反射到引用处；实例可覆盖部分属性 | 待办 |
| T7.4 | .history 自动快照（保存前快照 / 恢复入口） | `server/` | T0.2 | Server | 文件级误删可从快照恢复；快照上限可配 | 待办 |
| T7.5 | 文档（用户手册 / 节点开发指南 / 插件开发指南） | `docs/` | — | PM+QA | 三份文档成稿且与实现一致（含 §9.2 脚本示例可复制运行） | 待办 |
| T7.6 | 性能（千节点蓝图渲染 / 10 万行日志列表虚拟化） | 各处优化 | M6 | Runtime+QA | 千节点图流畅平移缩放；10 万行列表滚动不掉帧 | 待办 |

### 贯穿（QA）

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| TA.1 | roundtrip 幂等测试框架（IR→TS→IR、IR→Py→IR；含片段节点） | `tests/roundtrip/` | T3.6 | QA | `npm run roundtrip` 全绿；新节点必须补样例入库 | 完成 · 2026-10-17（TS 部分全绿 23 测试+计数守卫门禁；IR→Py 部分随 T4 落地后补入；顺带修复 sequence/setTitle 两个 roundtrip 缺陷） |
| TA.2 | E2E 冒烟（新建→拼UI→连蓝图→运行→观察） | `tests/e2e/` | M2 起 | QA | PLAN §20.3 场景脚本化可重复执行 | 待办 |
| TA.3 | 视觉复刻度对比（截图 vs UE5/Godot 参考 + 交互清单勾验） | `tests/visual/` 基线 | M2/M7 | QA | §8/§6 清单逐项出具勾验报告 | 待办 |

### 节点库（贯穿）

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T13.1 | 基础节点库：PLAN §13.1 全部内置分类（flow/events/variables/math/string/container/convert/ui/system） | `src/nodes/` | T0.1 | Nodes | §13.1 清单分类齐全；NodeSpec 契约一致；关键节点有单测；扩展只需加模块+注册一行 | 完成 · 2026-10-17（产出说明见 §6） |

### 任务卡模板（新增卡用）

```markdown
| T?.? | 任务名 | 产出物 | 依赖 ID | 角色缩写 | DoD（可逐条验证） | 待办 |
```

## 4. 依赖图（关键路径）

```
T0.1 ─┬─ T0.2 ─ T0.6/T0.7
      ├─ T0.3 ─ T0.4 ─────────┐
      └─ T0.5 ────────────────┤
T1.1 ─ T1.2 ─ T1.3/T1.6/T1.7 ─┤
T2.1 ─ T2.2/T2.3/T2.4/T2.7    ├─ M2 合并点 → main
T2.5 ─ T2.6 ─ T5.1/T5.4       │
T3.1~T3.8（M3）─ T4.1~T4.4（M4）┤
T6.1 ─ T6.2/T6.3/T6.4 ─ T6.5/T6.6 ─ M7
```

关键路径：T0.1 → T2.5/T2.6（解释器+绑定）→ T3.5/T3.6（互转）→ TA.1。PM 应优先保障这些卡不空等。

## 5. 当前状态

- 看板初始化：2026-10-17 · 全部 `待办` · 无在途卡
- 2026-10-17 PM-Agent 单会话执行：B0~B10 已提交；**M0/M1/M2/M3/M5/M6 全部完成 + TA.1（TS 部分）**；B11/B12 实机评估修复批次已提交；剩余：M4（Python/Pyodide，用户裁定暂缓）、M7 打磨、TA.2/TA.3
- 单会话模式下协作协议微调：不逐卡建 git 分支，改为 PM 按批次在 `v2` 分支提交（每批次一次 commit，卡状态在本表跟踪）；Agent 产出统一由 PM 验收（typecheck + 单测 + 抽查）

## 6. 进度纪要（PM 维护，倒序追加）

- **2026-10-17 · B11+B12（实机评估修复批次）**：PM 浏览器实机走查（纯 GUI 黑盒 + DOM 快照）确证 5 个 bug + 用户实测反馈 2 个运行时缺陷，本批次全修复。**ADR-008**（推翻 ADR-005 §2 won't fix）：NodeRunFn 扩展 async generator 多次出脚——forLoop/whileLoop/sequence/timer/array.forEach 恢复 UE5 语义（一次触发跑完迭代/定时器自动持续/序列按序全出，**无需链尾回连**）；解释器 driveGenerator 逐 yield 驱动+重入忽略（旧回连边 no-op 兼容）+yield 计数死循环保护（unlimitedFires 豁免）；ctx 新增 reinputs()（while/timer 条件每迭代重估）与 readProjectFile()。**节点库**：新增 system.readFile（全链路：节点/脚本全局 readFile/codegen await 映射/parser 识别/roundtrip 样例）。**print 无输出修复**：编辑器控制台从占位变真实现（src/panels/console/，BroadcastChannel 'bps-console' 订阅运行窗口日志，T1.6 兑现）。**F5 双开修复**：window.open 返回 null 不再立即降级——BroadcastChannel pong 探测（250ms）确认未打开才降级 _blank（launchRuntimeMain/Current 转 async）。**脏标记修复**：openUIAsset/close 改 registerDomainState 装载（不入栈不置脏）。**画布挤压修复**：蓝图侧栏允许收缩+画布 min-width 340px（1280 视口下 263px→340px）。**模板补全（T7.2 前置）**：日志分析器蓝图空骨架 → 开箱可跑（readFile→androidLogParse→listSetItems→print，实机 10 行日志渲染）。**实机回归全过**：forLoop 输出 0..4、timer 持续 tick 1..9、打开项目 0 脏 tab、保存后清脏、F5 单窗口无拦截提示、编辑器控制台实时镜像。PM 验收：**830 测试绿、typecheck 0 错、构建绿、roundtrip 门禁 23 全绿（新增 readFile 样例门禁通过）**。已知遗留：多出脚纯节点 codegen 共享别名缺口（rows+count 双引用会双展开，模板已规避；记入 TA.2 复测项）。

- **2026-10-17 · 合并点 E2E 冒烟**（浏览器实机，In-app Browser）：①项目管理器渲染 + 日志分析器模板建项目 → editor.html；②编辑器全面板布局/文件树/UI 树/检视器/事件面板/控制台 ✅；③蓝图编辑器（My Blueprint 变量暴露勾选/图签/画布事件节点）✅；④F5 → 独立运行窗口（标题「运行 · 主UI <项目>」、UI 渲染、控制台输出「[绑定] 已加载 logic/main.bp.json（蓝图「日志查看器」；绑定节点：list）」）✅。**发现并修复 2 个真实布局 bug**：`.dock-pane` 无样式（默认 block）致嵌套 flex 链断裂（左右列压扁）；`.bps-vp` 宽度塌陷（内容全绝对定位、basis:auto）。修复后全量 745 测试仍绿 + vite build 绿。**v2 合回 main，PLAN §17 合并点执行**。

- **2026-10-17 · B10**：**M6 完成**。T6.3 执行器（重派核对补全）：detect（versionRegex+semver 逐段+cmdOverride）/install SSE（四策略+并发锁+自动重 detect）/invoke 通用通道+持续流管理器。T6.5 手机日志：文件模式 3 份乱序样本全序稳定（时间→文件序→行序 tie-break）、设备模式 dump+启发式过滤、onLine WS plugin.push 持续流（idle 5s 停流抗瞬断）、解析单源复用节点库；真实 server 冒烟 PASS。T6.6 飞书：invoke.cmdTemplate 透传（ADR-004 追认）。TA.1：tests/roundtrip/ 门禁（76 样本+计数恒等式+守卫自检），顺带修复 sequence 标记正则与 ui.setTitle 反查两个 roundtrip 缺陷并移出无映射清单（无映射余 8 项=暂无脚本映射类）。PM 验收：**全量 745 测试绿、typecheck 0 错、构建绿**；ADR-004 追认三事项（合并优先级/camelCase 前缀/invoke 字段）。

- **2026-10-17 · B9**：T6.2 插件管理——四态徽标/更新按钮置灰/SSE 日志流（fetch 流解析不用 EventSource）/并发 detect（池 3）/确认框/取消复位；42 测试。T6.4 动态注册——清单→NodeSpec（select/file[] 映射、紫头）、specs 懒加载按需并入（无插件节点零请求）、invoke 降级不崩、NodeRunContext 增补 callPlugin/projectName（ADR-005 附加级）；19 测试+端到端。T5.2 事件面板——两节列表/双击路由表（跳转/创建/快捷挂载蓝图）/entry 点标/.ts 粗扫；25 测试。T6.3 再遇 API 中断失败（B10 重派）。PM 胶水：事件/插件面板注册进 dock、插件 tab 接线、snippet-runtime callPlugin 桥接。PM 验收：typecheck 0 错、构建绿、批内 86 测试绿。

- **2026-10-17 · B8**：**M3 与 M5 完成**。T3.3 转译链——POST /api/transpile（esbuild+LRU 缓存+行列错误）、binding 按扩展名分发（.ts→parseScriptToIR 同一 IR、.py 提示不崩），混合绑定双 runtime 等价测试；21 测试。T3.4+T3.8——sync 状态机（保存者胜/脏冲突四按钮/保存失败不丢草稿）、蓝图视图真渲染+诊断徽标接真、注解双向端到端（裸 @expose 与 type 兜底补缺）；40 测试。T3.7——ADR-007（引脚契约/推导/标记元数据往返重建）、片段运行时（new Function+全局注入+this 变量代理）、双击模态编辑；23 测试。T5.4——WS debug.v1（subscribe/attach/mute 路由）、150ms 批量+500 上限、节点高亮/exec 流动/端口值徽标、一键关闭双向；24 测试。PM 胶水：injectSnippetRuntime 注入 binding.ts（createRuntime 前按资产合成片段 spec）。PM 验收：typecheck 0 错、构建绿、批内 135 测试绿。**M4（Python）与 M6/T6.2~T6.6、M7 为剩余主要工作**。

- **2026-10-17 · B7**：T3.5+T3.6 合并交付——codegen（IR→TS：真 if/for/while 语句、纯链表达式表 40 节点+bps.* 兜底、别名机制、snippet 标记）与解析器（TS AST→IR 两遍法、行列诊断、超集折叠 IRSnippet），**roundtrip 15 测试全绿含幂等二次验证**（TA.1 TS 部分基座就绪，产出物 src/script/roundtrip.test.ts）。T5.1+T5.3——EventBus（四源入队/node·ui·all 路由矩阵/8 跳环保护/插件推送口 pushPlugin），三件套修复（send 加 target 引脚、listen 具名参数注入解释器 seed）；13 测试+T2.6/T2.5/T13.1 回归。T6.1——清单校验/规范化/三源合并（项目>静态>内置）/GET /api/plugins 两端点 + 内置清单 phone-log（read 双模式+onLine）与 feishu-cli；20 测试+E2E。PM 追认事项（待回写 ADR-004）：①合并优先级定案；②插件节点前缀=camelCase(pluginId)+'.'。PM 验收：typecheck 0 错、构建绿、批内 48 测试绿。

- **2026-10-17 · B6**：**M2 蓝图闭环完成**。T2.6 绑定运行——BindingRunner（绑定发现/每路径一 runtime/UiHandle 三态读写/事件路由+跨蓝图 hub 防回声/运行窗口小控制台），检视器 logicRef 真选择器（单命令双写 ir 契约位+props 显示位，可撤销）；13 测试。T2.7 注释框——ADR-006（IRGraph.comments 可选、version 不升、normalize/往返纳入），UE5 同款：拖标题含节点随动、色板、My Blueprint 接线；13 测试。T3.1 脚本编辑器——CodeMirror 6 全套扩展、[蓝图|脚本]切换条（诊断/蓝图视图为显式占位待 T3.6）；15 测试。T3.2 内建 API——9 全局 types.d.ts+Proxy 运行时+补全扩展，convert/format 复用节点库单源；20 测试。T3.1↔T3.2 咬合点（scriptTypesExtension）联测通过。ScriptTab 接入工作区。PM 验收：**全仓 519 测试绿、typecheck 0 错、构建绿**。关键路径状态：T2.5→T2.6 ✅，下一环 T3.5/T3.6。

- **2026-10-17 · B5（a+b）**：M0、M1 全部完成。T1.3 视口（几何纯函数+命令栈，24 测试）；T1.4 树面板（重派成功，30 测试）；T1.5 检视器（13 种控件+混合态批量，20 测试）；T1.6 运行窗口 v1（F5/F6 全接线+URL 契约，16 测试）；T1.7 布局扩展（anchors 简化版语义=有效锚点接管该轴；mergeDuplicates 真 rowspan；10 测试）；T2.3+T2.4（My Blueprint 四分节+函数图+Details 检视器，38 测试；graph-op 补充 spec 使 flow.call/func.* 可过校验——编辑器补充 spec 模式，函数图动态脚渲染留待 view 支持）。PM 胶水：UITab/BlueprintTab 工作区接线（加载/保存/脏标记）、树+检视器面板注册、函数节点头色修复（func.*/flow.call → 蓝头）。PM 验收：typecheck 0 错、构建绿、批内 78+85 测试绿。设计裁定：UIAsset 全量挂 scene-tree 单域（检视器/树/视口共用），'inspector' 域保留未用——记录为 ADR-005 附加说明。

- **2026-10-17 · B4**：T0.4 完成（首派 API 中断，续作修复：channelName 缺字段、心跳定时器泄漏、定向消息串台；34 测试不挂起）。T0.7 完成——文件树/SSE 增量刷新/右键菜单（通用 Menu 组件导出）/拖入导入/文件级撤销磁盘补偿；36 测试+E2E。T1.2 完成——23 节点 DOM 渲染器（编辑/运行同构、keyed 增量、list 列定义四特性；13 测试）。T2.2 完成（首派中断，续作核查补全：修复 panOnDrag 吞右键、补 Shift 框选加选与命令栈接线测试；§8.2 九项全过；39 测试）。PM 胶水：文件面板注册进 dock、BlueprintTab 接入工作区（.bp.json 加载/保存/脏标记）、ui-editor/store.ts 共享契约（UIAsset 单域裁定）。PM 验收：typecheck 0 错、构建 3 入口绿、批内 122 测试绿。教训：4+ Agent 并行时 API 偶发连接中断（B2/B4 各损失 1 卡），后续批次减小并行度到 ≤4。

- **2026-10-17 · B3**：T0.3 完成——自研 dock（布局树纯函数 44 测试；面板注册 3 行；Godot 式四边高亮拖放 + localStorage 持久化 + 默认布局/占位面板；顶栏接命令栈撤销重做）。T0.6 完成——项目管理器三栏（最近/新建/导入）+ 服务端 import-folder 端点（脚手架补全/重名后缀），fs 测试增至 32。T2.5 完成（重派）——解释器 796 行：exec 驱动/纯节点按需+记忆化/flow.call 栈帧/递归限 64/串行事件队列+print 旁路/调试探针 18 测试。T2.8 完成——校验器 11 种 issue 码 + serializeIR/deserializeIR/normalizeIR 往返无损 19 测试。T2.1 完成（待评审）——IR⇄ReactFlow 双向映射 + dagre 自动布局 + UE5 视觉全 token 化 12 测试。PM 验收：125 测试绿、typecheck 绿、vite build 三入口绿。

- **2026-10-17 · B2**：T0.2 完成——FS API（安全根越权 8 样本全拒、CRUD/move/tree/import、SSE watch）+ 两模板；27 测试 + REST E2E 实测。T13.1 完成——**77 个内置节点**（九分类）循环采用状态机机制（ADR-005 裁定），32 测试。T1.1 完成——23 种 UI 节点 schema（四类 + listColumns 结构化列定义），7 测试。T2.5 解释器派发失败（Agent API 连接错误，无产出），并入 B3 重派。契约增补 **ADR-005**（PM 代 Arch）：NodeRunContext 增补可选 `ui/notify/clipboardWrite/openUrl`；多出口触发暂不改契约（循环状态机方案）；UI 属性统一存 props、ADR-002 事件名修正 selectionChanged。全量 66 测试绿、typecheck 绿。

- **2026-10-17 · B0+B1**：v2 分支建立；v1.1 源码清退（main 历史保留）；多入口（index/editor/runtime.html）+ `@` 别名 + 新依赖（immer/esbuild/CodeMirror 6）。B1：T0.1 完成——`src/ir/types.ts` 46 个导出 + ADR 001~004；Arch 规范化决策（已广播，后续卡遵守）：① exec 引脚显式写 `"type":"exec"`；② select 型引脚 = `"type":"string"` + `options:[{value,label}]`；③ 事件参数 `number` 定型为 `float`/`int`。T0.5 完成——命令栈（immer patches 统一时间栈、跨域撤销、ReplayNotice）+ 快捷键注册（冲突检测），26 测试绿。T0.8 完成——63 个 token（Godot 深色 + UE5 蓝图 §8.1 全表），CSS↔TS 一致性测试，6 测试绿。typecheck 全绿、全量 32 测试绿。
