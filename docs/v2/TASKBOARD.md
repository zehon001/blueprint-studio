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
| T0.3 | Dock 外壳与面板注册框架（拖拽吸附 / 布局持久化） | `src/shell/dock/` | T0.1 | Shell | 任意面板可拖到四边/中心成 tab；布局刷新后还原；新面板注册 ≤10 行代码 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.4 | 多窗口拆合（BroadcastChannel 按序重放） | `src/shell/windows/` | T0.3 | Shell | 拆出的面板与主窗状态实时一致（双向改 store 均同步）；关闭弹窗内容回主窗；弹窗被拦截时降级新标签页 | 完成 · 2026-10-17（首派中断，续作修复；34 测试；浏览器端多窗实测待 B5 后 PM 抽查） |
| T0.5 | 统一命令栈（immer patches）+ 快捷键框架 | `src/shell/commands/` | — | Shell | 蓝图/UI/属性三域各接一个示例命令；Ctrl+Z/Shift+Z 正确跨域撤销；快捷键注册含冲突检测 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.6 | 项目管理器页（最近 / 新建模板 / 导入文件夹 / 打开） | `src/shell/project-manager/` | T0.2 | Shell | 新建→进入主编辑器；最近列表持久化；导入任意文件夹成功打开 | 完成 · 2026-10-17（产出说明见 §6） |
| T0.7 | 文件系统面板（树 / 右键增删改重命名 / 拖入导入） | `src/panels/file-system/` | T0.2, T0.5 | Shell | 增删改重命名全可用且可撤销；与磁盘实际状态一致 | 完成 · 2026-10-17（36 测试 + 服务端 E2E；已注册进 dock） |
| T0.8 | 主题系统（Godot 深色 token + UE5 蓝图配色 token） | `src/shell/theme/` | — | Shell | 全部颜色/间距 token 化无硬编码；蓝图节点引脚色符合 PLAN §8.1 表 | 完成 · 2026-10-17（产出说明见 §6） |

### M1 UI 闭环

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T1.1 | UI 节点库 schema（PLAN §7.1 全部节点 + 属性声明） | `src/ui-editor/schema/` | T0.1 | UIEditor | 4 类节点齐全；每个属性有类型/默认值/分组；检视器可纯 schema 驱动 | 完成 · 2026-10-17（产出说明见 §6） |
| T1.2 | DOM 渲染器（编辑态/运行态共用，编辑冻结交互） | `src/runtime/render/` | T1.1 | UIEditor+Runtime | 同一 UI 树两态渲染一致；容器布局正确嵌套 | 待办 |
| T1.3 | 2D 视口（选择/框选/移动/对齐吸附/缩放/键盘微调） | `src/ui-editor/viewport/` | T1.2 | UIEditor | PLAN §7.2 操作全可用；操作均入命令栈可撤销 | 待办 |
| T1.4 | UI 树面板（树形/拖拽重排父子/右键菜单） | `src/panels/scene-tree/` | T1.1, T0.5 | UIEditor | 拖拽改变父子即时反映到视口；右键含「添加节点/复制/删除/附加逻辑资产(占位)」 | 待办 |
| T1.5 | 检视器（分组/搜索/类型编辑器/多选混合态） | `src/panels/inspector/` | T1.1, T0.5 | UIEditor | schema 驱动生成；搜索过滤属性；多选显示共同属性；改动可撤销 | 待办 |
| T1.6 | 运行窗口 v1（runtime.html 加载 UI 静态渲染） | `src/runtime/`、`server/static.ts` | T1.2, T0.2 | Runtime | F5/F6 打开独立窗口正确渲染主 UI / 当前 UI；窗口标题含运行模式 | 待办 |
| T1.7 | Transform 与容器布局（position/rotation/size + VBox/HBox/Grid 排列） | 渲染器扩展 | T1.2 | UIEditor | 旋转/尺寸视觉正确；容器子节点按布局排列；锚点简化版生效 | 待办 |

### M2 蓝图闭环

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T2.1 | 蓝图视觉系统（节点头配色/引_PIN 色标/连线样式/网格画布） | `src/blueprint/view/` | T0.1, T0.8 | Blueprint | 与 UE5 截图并排对比：分类配色、引脚色、exec 白线/数据彩虚线全部符合 §8.1 | 待评审 · 2026-10-17（映射与样式已 token 化并单测；截图对比待 B5 集成后 PM 浏览器验收） |
| T2.2 | 画布交互（右键搜索/引脚拖出弹兼容菜单/自动转换节点/断开/框选/复制粘贴/Ctrl拖拽复制/平移缩放） | `src/blueprint/interaction/` | T2.1 | Blueprint | §8.2 清单逐项可用；不兼容类型拖线自动插转换节点；复制粘贴跨图可用 | 完成 · 2026-10-17（首派中断后核查补全；§8.2 九项全过 + 修复右键被吞 bug；39 测试） |
| T2.3 | 结构面板 My Blueprint（变量/函数/事件 + 暴露→Get·Set 自动生成） | `src/blueprint/my-blueprint/` | T2.1 | Blueprint | 变量勾「暴露」后拖入图生成 Get/Set；函数子图含入口/出口节点，主图调用节点自动出现 | 待办 |
| T2.4 | 蓝图检视器（节点参数/引脚默认值/文档） | `src/blueprint/details/` | T2.1 | Blueprint | 选中节点显示参数与未连线引脚默认值，可编辑入命令栈 | 待办 |
| T2.5 | IR 解释器 v2（exec+数据流/函数调用/异步/串行事件队列+旁路） | `src/runtime/interpreter/` | T0.1 | Runtime | v1.1 语义对齐（exec 链不穿纯节点、事件保序、RPC 旁路）；含单元测试 | 完成 · 2026-10-17（18 测试；B2 失败后重派成功） |
| T2.6 | 蓝图绑定 UI 节点 + 事件驱动运行 | 绑定属性 + 运行窗口接线 | T2.5, T1.6 | Runtime | 检视器可挂 `.bp.json` 到节点；按钮点击触发蓝图事件节点；`ui` 访问器读写子树节点 | 待办 |
| T2.7 | 注释框 Comment 节点（可调色/框选整体移动） | 蓝图编辑器 | T2.2 | Blueprint | UE5 同款行为；注释含节点随注释移动 | 待办 |
| T2.8 | 保存校验器（类型连线/悬空 exec/未知节点 → 错误列表跳转） | `src/ir/validate.ts` | T0.1 | Arch | 构造 5 类错误样本全部报出且点击跳节点；`.bp.json` 往返序列化无损 | 完成 · 2026-10-17（19 测试；normalizeIR 供 roundtrip 复用） |

### M3 脚本（TS）闭环

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T3.1 | 脚本编辑器（CodeMirror 6 · TS 高亮 · 诊断标记 · [蓝图/脚本]切换条） | `src/script/editor/` | T0.3 | Script | 打开 `.ts` 逻辑资产可编辑保存；切换条切到蓝图视图正常渲染 | 待办 |
| T3.2 | 内建 API 与类型包（ui/vars/emit/onEvent/plugins/print/convert/format/delay） | `src/script/api/` | T0.1 | Script | PLAN §9.2 全部全局有类型声明与文档注释；TS 资产有补全 | 待办 |
| T3.3 | TS 转译执行链（服务端 esbuild → 运行窗口沙箱执行） | `server/` + `src/runtime/sandbox/` | T2.6 | Script+Server | `.ts` 逻辑资产挂 UI 节点后运行窗口行为与蓝图等价（同一 IR） | 待办 |
| T3.4 | 注解处理（@tool/@expose/@on → IR 变量/事件节点） | `src/script/annotations.ts` | T3.2 | Script | 脚本写 @expose → 蓝图出现对应 Get/Set；@on → 事件节点；双向（蓝图勾暴露→codegen 生成注解） | 待办 |
| T3.5 | Codegen：IR → TS（含纯节点链内联表达式合成） | `src/script/codegen-ts.ts` | T3.4 | Script | PLAN §10 规则全实现；生成代码可读（无嵌套超 3 层的节点链展开）；roundtrip 幂等 | 待办 |
| T3.6 | 受控子集解析器：TS → IR | `src/script/parser-ts.ts` | T3.5 | Script | if/for/while/表达式/函数/emit/await 映射正确；语法错误给出行列诊断 | 待办 |
| T3.7 | 脚本片段节点（不可映射段兜底） | IR 扩展 + 蓝图节点 | T3.6 | Script+Blueprint | 含片段的资产往返（IR→TS→IR）无损；片段节点可展开编辑源码 | 待办 |
| T3.8 | 双视图同步协议（保存者胜 / 过期提示重载） | 编辑器接线 | T3.5, T3.6 | Script+Arch | 两视图同开时后保存者胜，另一侧切回提示重载；无脏丢失 | 待办 |

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
| T5.1 | 事件总线（UI/系统/插件推送/自定义；目标路由 本节点/本UI/全部） | `src/runtime/events/` | T2.6 | Runtime | PLAN §11 全场景；事件间保序；旁路不死锁 | 待办 |
| T5.2 | 事件面板（内建+自定义列表 / 双击创建跳转） | `src/panels/events/` | T5.1, T2.3 | UIEditor+Blueprint | 选中 UI 节点列出其内建事件与资产自定义事件；双击建/跳事件节点 | 待办 |
| T5.3 | 事件节点三件套（自定义事件 / 发送事件 / 监听） | `src/nodes/events.ts` | T5.1 | Nodes | 多参数事件可定义；发送→监听 E2E 通 | 待办 |
| T5.4 | 运行时蓝图观察（WS 反向：节点高亮/exec 流动/端口实时值 150ms 批量） | 调试探针 + 编辑器叠加层 | T2.6 | Runtime | v1.1 能力全保留；编辑器开该蓝图视图自动接入；可一键关闭 | 待办 |

### M6 插件系统

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T6.1 | 插件清单格式 + 三源注册表（内置/项目/静态目录合并去重） | `plugins-registry/`、`server/plugins/registry.ts` | T0.1, T0.2 | Plugin+Server | 三源清单正确合并；清单 schema 校验 | 待办 |
| T6.2 | 插件管理子界面（列表/徽标/两按钮/进度日志） | `src/panels/plugin-manager/` | T6.1 | Plugin | §14.2 全交互；最新版时更新按钮置灰 disabled；安装日志实时滚动 | 待办 |
| T6.3 | CLI 检测/安装/更新执行器（strategy: winget/npm-global/download-zip/custom-cmd；版本解析） | `server/plugins/executor.ts` | T6.1 | Server | detect 失败=未安装；安装后状态自动刷新；命令可被设置覆盖；执行流式回传日志 | 待办 |
| T6.4 | 插件节点动态注册（清单 → NodeSpec → 蓝图可搜可用） | `src/nodes/dynamic.ts` | T6.1, T2.2 | Plugin | 节点出现在右键搜索；exec/数据引脚可用；调用走 CLI 桥/自定义执行器 | 待办 |
| T6.5 | 手机日志插件（双模式 + Android 日志解析 + 多文件时间归并） | `plugins-registry/phone-log.json` + 执行器 | T6.3, T6.4 | Plugin | §14.3 全项：adb dump/流式两节点；3 份乱序样本→按时间稳定有序；两种 Android 格式可解析 | 待办 |
| T6.6 | 飞书 CLI 插件清单（检测/安装/更新 + 节点封装，不实现功能本体） | `plugins-registry/feishu-cli.json` | T6.3 | Plugin | 未安装显示下载；已装最新置灰更新；节点仅封装（调用透传 CLI 输出） | 待办 |

### M7 打磨

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| T7.1 | 快捷键全表 + 设置界面（可查可改 + 冲突检测） | `src/shell/keymap/` | T0.5 | Shell | PLAN §15 表落齐；改键持久化 | 待办 |
| T7.2 | 模板项目（空 / 日志分析器示例） | `templates/` | M6 | Nodes+Shell | 新建向导可选模板；日志分析器模板开箱可跑 | 待办 |
| T7.3 | UI 预制体（.ui.json 嵌套实例化 / 双击进入编辑） | UI 编辑器 | T1.4 | UIEditor | 预制体改动反射到引用处；实例可覆盖部分属性 | 待办 |
| T7.4 | .history 自动快照（保存前快照 / 恢复入口） | `server/` | T0.2 | Server | 文件级误删可从快照恢复；快照上限可配 | 待办 |
| T7.5 | 文档（用户手册 / 节点开发指南 / 插件开发指南） | `docs/` | — | PM+QA | 三份文档成稿且与实现一致（含 §9.2 脚本示例可复制运行） | 待办 |
| T7.6 | 性能（千节点蓝图渲染 / 10 万行日志列表虚拟化） | 各处优化 | M6 | Runtime+QA | 千节点图流畅平移缩放；10 万行列表滚动不掉帧 | 待办 |

### 贯穿（QA）

| ID | 任务 | 产出物 | 依赖 | 负责 | DoD | 状态 |
|---|---|---|---|---|---|---|
| TA.1 | roundtrip 幂等测试框架（IR→TS→IR、IR→Py→IR；含片段节点） | `tests/roundtrip/` | T3.6 | QA | `npm run roundtrip` 全绿；新节点必须补样例入库 | 待办 |
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
- 2026-10-17 PM-Agent 单会话执行：B0~B4 已提交；B5 派发 T1.3/T1.4/T1.5/T1.6/T1.7/T2.3+T2.4（PM 先行建 src/ui-editor/store.ts 作为三卡共同契约：UIAsset 挂 scene-tree 域、selection 独立）
- 单会话模式下协作协议微调：不逐卡建 git 分支，改为 PM 按批次在 `v2` 分支提交（每批次一次 commit，卡状态在本表跟踪）；Agent 产出统一由 PM 验收（typecheck + 单测 + 抽查）

## 6. 进度纪要（PM 维护，倒序追加）

- **2026-10-17 · B4**：T0.4 完成（首派 API 中断，续作修复：channelName 缺字段、心跳定时器泄漏、定向消息串台；34 测试不挂起）。T0.7 完成——文件树/SSE 增量刷新/右键菜单（通用 Menu 组件导出）/拖入导入/文件级撤销磁盘补偿；36 测试+E2E。T1.2 完成——23 节点 DOM 渲染器（编辑/运行同构、keyed 增量、list 列定义四特性；13 测试）。T2.2 完成（首派中断，续作核查补全：修复 panOnDrag 吞右键、补 Shift 框选加选与命令栈接线测试；§8.2 九项全过；39 测试）。PM 胶水：文件面板注册进 dock、BlueprintTab 接入工作区（.bp.json 加载/保存/脏标记）、ui-editor/store.ts 共享契约（UIAsset 单域裁定）。PM 验收：typecheck 0 错、构建 3 入口绿、批内 122 测试绿。教训：4+ Agent 并行时 API 偶发连接中断（B2/B4 各损失 1 卡），后续批次减小并行度到 ≤4。

- **2026-10-17 · B3**：T0.3 完成——自研 dock（布局树纯函数 44 测试；面板注册 3 行；Godot 式四边高亮拖放 + localStorage 持久化 + 默认布局/占位面板；顶栏接命令栈撤销重做）。T0.6 完成——项目管理器三栏（最近/新建/导入）+ 服务端 import-folder 端点（脚手架补全/重名后缀），fs 测试增至 32。T2.5 完成（重派）——解释器 796 行：exec 驱动/纯节点按需+记忆化/flow.call 栈帧/递归限 64/串行事件队列+print 旁路/调试探针 18 测试。T2.8 完成——校验器 11 种 issue 码 + serializeIR/deserializeIR/normalizeIR 往返无损 19 测试。T2.1 完成（待评审）——IR⇄ReactFlow 双向映射 + dagre 自动布局 + UE5 视觉全 token 化 12 测试。PM 验收：125 测试绿、typecheck 绿、vite build 三入口绿。

- **2026-10-17 · B2**：T0.2 完成——FS API（安全根越权 8 样本全拒、CRUD/move/tree/import、SSE watch）+ 两模板；27 测试 + REST E2E 实测。T13.1 完成——**77 个内置节点**（九分类）循环采用状态机机制（ADR-005 裁定），32 测试。T1.1 完成——23 种 UI 节点 schema（四类 + listColumns 结构化列定义），7 测试。T2.5 解释器派发失败（Agent API 连接错误，无产出），并入 B3 重派。契约增补 **ADR-005**（PM 代 Arch）：NodeRunContext 增补可选 `ui/notify/clipboardWrite/openUrl`；多出口触发暂不改契约（循环状态机方案）；UI 属性统一存 props、ADR-002 事件名修正 selectionChanged。全量 66 测试绿、typecheck 绿。

- **2026-10-17 · B0+B1**：v2 分支建立；v1.1 源码清退（main 历史保留）；多入口（index/editor/runtime.html）+ `@` 别名 + 新依赖（immer/esbuild/CodeMirror 6）。B1：T0.1 完成——`src/ir/types.ts` 46 个导出 + ADR 001~004；Arch 规范化决策（已广播，后续卡遵守）：① exec 引脚显式写 `"type":"exec"`；② select 型引脚 = `"type":"string"` + `options:[{value,label}]`；③ 事件参数 `number` 定型为 `float`/`int`。T0.5 完成——命令栈（immer patches 统一时间栈、跨域撤销、ReplayNotice）+ 快捷键注册（冲突检测），26 测试绿。T0.8 完成——63 个 token（Godot 深色 + UE5 蓝图 §8.1 全表），CSS↔TS 一致性测试，6 测试绿。typecheck 全绿、全量 32 测试绿。
