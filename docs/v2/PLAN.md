# Blueprint Studio v2 —— 「工具制作引擎」完整实现方案

> 版本：v2.0-draft1（2026-10-17） · 配套文件：[TASKBOARD.md](./TASKBOARD.md)（任务看板 / Agent 分工）
> 本文档只做方案设计，不包含实现代码。文中代码块均为**格式与 API 的示意**，用于固化契约。

## 0. 已拍板的架构决策（不再讨论）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 运行形态 | **本地 Web 服务**：npm 启动本地 Node 服务，浏览器访问编辑器；拆分面板 / 运行窗口用浏览器弹出窗口实现，后续可平滑封装桌面应用 |
| D2 | 改造策略 | **同仓库重写 v2**：保留 git 历史，复用 v1.1 可复用经验；旧 DSL 与 IndexedDB 演示数据不迁移 |
| D3 | 蓝图⇄脚本 | **单一资产双视图**：逻辑资产内部统一存 IR（中间表示），蓝图 / 脚本是同一资产的两个视图，双向同步；脚本侧用受控写法 + 注解，不可映射段折叠为「脚本片段节点」 |
| D4 | Python 执行 | **浏览器 Pyodide**：与 TS 共用运行沙箱；本机能力（文件 / CLI / adb）一律经本地服务桥接 |

---

## 1. 定位

一个**工具制作引擎**：外观与操作完全复刻 Godot 编辑器、蓝图完全复刻 UE5 的网页版引擎，用于制作「UI 工具类软件」（如手机日志分析器、报表推送器），而非游戏。

- 做工具 → 只保留 UI 相关能力（控件、布局、Transform），**不含**物理 / 角色 / 模型 / 动画等游戏内容。
- 能力扩展靠**插件**（adb、飞书 CLI 等外部工具的检测 / 安装 / 更新 / 节点封装）。
- 做出来的工具在**独立运行窗口**中执行，编辑器可实时观察运行中蓝图。

## 2. 术语映射（全局统一词汇，所有代码 / UI / 文档遵守）

| Godot | UE5 | v2 术语（定名） | 落地物 |
|---|---|---|---|
| Project | Project | **工具项目** | 文件夹 + `project.json` |
| Scene | Widget Blueprint | **UI**（不叫场景） | `*.ui.json` 节点树 |
| Node | Widget | **UI 节点** | 树节点 + DOM 渲染 |
| Signal | Delegate / Event | **事件**（不叫信号） | 事件总线 |
| Script (GDScript) | Blueprint / C++ | **逻辑资产**（蓝图或脚本） | `.bp.json` / `.ts` / `.py` |
| Main Scene | Game Mode | **主 UI**（项目入口） | `project.json.mainUI` |
| Inspector | Details Panel | **检视器** | 右侧面板 |
| FileSystem Dock | Content Browser | **文件系统面板** | 左侧面板 |
| Signals Dock | — | **事件面板** | 右侧面板 |
| Run (F5) | PIE | **运行** | 独立浏览器窗口 |
| Plugin | Plugin | **插件**（CLI 插件 / 自定义插件） | 注册表 + 管理界面 |

命名规则：场景→一律叫「UI」；信号→一律叫「事件」；运行→独立窗口。

## 3. 总体架构

```
┌ 浏览器 ────────────────────────────────────────────────────────────┐
│ ① 项目管理器页          ② 主编辑器（dock 面板集合，可拆出弹窗）        │
│    最近/新建/导入          ┌ 左：文件系统 / UI 树 ─ 中：工作区(tabs) ─ 右：检视器/事件面板 ─ 底：控制台 ┐
│                           │ 工作区 tab 类型：UI 编辑 / 蓝图编辑 / 脚本编辑 / 插件管理              │
│ ③ 运行窗口（独立浏览器窗口 runtime.html）                              │
│     UI 节点渲染(DOM) + IR 解释器 / TS·Pyodide 沙箱 + 调试探针          │
└────────────┬─────────────────────────────┬───────────────────────────┘
     HTTP/WS │ 文件 CRUD / 转译 / 插件调用   │ 调试观察通道（WS 反向推送）
┌ 本地 Node 服务 ──────────────────────────────────────────────────────┐
│  项目 FS API（安全根内） · TS 转译(esbuild) · Pyodide 静态托管         │
│  插件管理器（检测/安装/更新外部 CLI） · CLI 桥(child_process)          │
│  静态目录托管（自定义插件 / 资产） · WS Hub（编辑器↔运行窗口）          │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 窗口模型（对应需求 9）

- 所有面板（**含蓝图编辑器**）都是独立可 dock 的单元：可拖到主窗边缘吸附、可「拆出」为浏览器弹出窗口（`window.open` + `BroadcastChannel` 同步状态）、弹窗可拖回合体。
- **运行窗口**：F5 运行主 UI / F6 运行当前 UI，新开浏览器窗口加载 `runtime.html`（Godot 同款习惯）。
- 弹窗被浏览器拦截 / 环境受限时，降级为「新标签页打开该面板」。
- 状态同步：zustand store 的 action 经 `BroadcastChannel` 按序广播，各窗口以相同 reducer 重放，保证多窗口一致；布局状态每窗口独立存 localStorage。

### 3.2 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端框架 | React 18 + TypeScript + Vite | 沿用 v1.1 |
| 状态 | zustand + immer | 命令栈（撤销重做）基于 immer patches |
| 图编辑 | @xyflow/react 深度定制 | 节点 / 连线完全自定义 renderer 复刻 UE5 视觉；必要时连线层自绘 SVG |
| 代码编辑 | CodeMirror 6（新增） | TS / Python 高亮、诊断标记 |
| TS 转译 | 本地服务内置 esbuild（新增） | 运行窗口向服务端请求转译，避免浏览器端 wasm 体积 |
| Python | Pyodide，本地服务静态托管（新增） | 懒加载，首次进入 Python 资产才加载 |
| 服务端 | Node + ws（沿用）+ node:child_process | CLI 桥、文件监听 |

## 4. 项目模型与文件格式

### 4.1 项目结构（Godot 习惯：文件夹即项目，资产即文件）

```
MyTool/
  project.json        # { name, mainUI, engineVersion, plugins: {phoneLog: true, ...} }
  ui/                 # UI（场景）资产
    main.ui.json
    detail.ui.json
  logic/              # 逻辑资产（蓝图 / 脚本，可放子目录）
    main.bp.json      # 蓝图：IR 直接序列化
    parser.ts         # 脚本：源码即存储
    helper.py
  assets/             # 图片等静态资源（服务端静态托管）
  plugins/            # 项目级自定义插件（可选）
  .history/           # 自动快照（支撑文件级撤销恢复，git ignore）
```

- 蓝图文件可跨项目复制复用：资产右键「复制 / 移动 / 重命名」，直接拷文件即可共享。
- 蓝图引用其它蓝图：函数库节点指定相对路径 + 函数名。

### 4.2 蓝图绑定 UI 节点（对应需求 1）

- UI 节点检视器中有「逻辑资产」属性：选择 / 新建 `.bp.json` / `.ts` / `.py`，挂到该节点（= Godot 节点挂脚本 / UE Widget 挂图）。
- 逻辑资产内 `ui` 访问器指向**被绑定的节点**（子树根）；`ui.list` = 绑定节点子树中 name 为 `list` 的节点。
- 事件面板双击某事件 → 自动创建 / 跳转到该逻辑资产中对应的事件节点 / `@on` 方法。

## 5. 统一 IR（逻辑资产核心，对应需求 2/3）

所有逻辑资产在内存中都是同一种 IR；蓝图视图 = 图渲染 IR，脚本视图 = codegen(IR)，脚本文本 = 解析(TS/Py) → IR。

```jsonc
// IR 结构示意（.bp.json 即其序列化）
{
  "version": 2,
  "name": "日志查看器",
  "entry": "bind",                    // 绑定 UI 节点时使用的主图
  "graphs": {                          // 主图 + 函数（子蓝图）
    "bind":    { "nodes": [...], "edges": [...] },
    "parseLog": { "nodes": [...], "edges": [...], "params": [...], "returns": [...] }
  },
  "variables": [
    { "name": "packageName", "type": "string", "default": "com.demo",
      "exposed": true, "category": "配置" }        // exposed → 自动生成 Get/Set 节点 + 脚本 @expose
  ],
  "events": [                          // 自定义事件（含事件发送节点 / 监听节点的目标）
    { "name": "loaded", "params": [{ "name": "count", "type": "number" }] }
  ],
  "snippets": [                        // 脚本片段节点（互转兜底，见 §10）
    { "id": "snip1", "lang": "ts", "code": "...", "pins": [...] }
  ],
  "layout": { "bind": { "zoom": 1, "pan": [0, 0] } }   // 视图状态（仅蓝图视图使用）
}
```

- 节点引用节点库 `NodeSpec`（§13），边 = exec 边 + 数据边（UE 语义：exec 链不能穿过纯节点，编辑时拦截）。
- IR 带 `version`，引擎升级附迁移函数（`docs/v2/adr/` 记录每次格式变更）。
- 校验器：类型不匹配的连线、悬空 exec、未使用变量、未知节点 → 错误 / 警告列表（保存时跑，蓝图编辑器底部显示）。

## 6. 编辑器外壳（复刻 Godot，对应需求 3/8）

### 6.1 项目管理器（独立页面）

最近项目列表、新建（模板：空项目 / 日志分析器）、导入（选任意文件夹路径，服务端 FS API）、打开即进入主编辑器。

### 6.2 主编辑器布局（默认布局，可自由调整）

```
┌ 顶栏：logo · 运行▶(F5 主UI) 运行当前(F6) · 调试开关 · 保存 · 撤销/重做 ┐
├ 左列 ─────────────┬ 中央工作区（tabs）───────────┬ 右列 ────────────┤
│ 文件系统面板        │ [UI 编辑] [蓝图编辑] [脚本]…  │ 检视器            │
│ （树 + 增删改导入） │                              │ 事件面板          │
│ UI 树面板          │                              ├ 底部：控制台/调试  │
└──────────────────┴──────────────────────────────┴──────────────────┘
```

- 每个面板标题栏有「拆出窗口 ⊞ / 关闭 ×」；拖动标题栏到边缘出现放置高亮（Godot 同款手感）。
- 蓝图编辑器内部自带 UE5 式「My Blueprint」结构面板与检视器（§8）。

### 6.3 操作习惯（全局统一，验收口径见 TASKBOARD）

- 复制 / 剪切 / 粘贴 / 删除：蓝图节点（含连线）、UI 节点、文件资产、检视器数值；蓝图内 Ctrl+拖拽 = 复制节点。
- 撤销 / 重做：统一命令栈 `CommandStack`（命令 = { label, do, undo(immer patch), domain }），域：blueprint / scene-tree / inspector / filesystem；文件移动 / 删除的撤销 = 逆操作 + `.history` 快照兜底。Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y。
- 多选（点选 / 框选）、右键上下文菜单 everywhere、Ctrl+S 保存（tab 脏标记 ●）、双击资产打开。
- 快捷键表对齐 Godot/UE 习惯并在设置中可查可改（含冲突检测）。

## 7. UI 节点系统（场景编辑，对应需求 3/8）

### 7.1 UI 节点库（Control 系，声明式 schema）

| 分类 | 节点 |
|---|---|
| 容器 | VBox · HBox · Grid · Panel · ScrollBox · TabContainer · SplitContainer |
| 显示 | Label · RichText · Markdown · Image · Separator · ProgressBar |
| 输入 | Button · Check · LineEdit · TextEdit · OptionButton · Slider · SpinBox |
| 数据 | List（列定义：字段/标题/颜色映射/分组/合并，继承 v1.1 亮点）· Table · Tree |

- 每节点：`name`（树内唯一名）、`transform`（position / rotation / size，容器布局优先）、`theme` 样式属性、内建事件清单。
- 属性 schema 声明式定义 → 检视器自动生成编辑器（数字 / 枚举 / 颜色 / 布尔 / 向量 / 资源引用 / 逻辑资产引用）。
- 编辑态与运行态共用同一 DOM 渲染器（沿用 v1.1 UIRenderer 思路），编辑时交互冻结。

### 7.2 2D 视口

选择 / 框选 / 移动 / 方向键微调 / 对齐吸附线 / 滚轮缩放 / 锚点与布局提示；UI 树面板支持拖拽重排父子、右键（添加节点 / 复制 / 删除 / 附加逻辑资产 / 保存为预制体）。

### 7.3 检视器

分组折叠、属性搜索、多选批量编辑（共同属性显示混合态）、修改即入命令栈（可撤销）。选中 UI 节点时同时显示「内建事件」区（跳转事件面板）。

### 7.4 UI 预制体

任意 `.ui.json` 可被其它 UI 实例化引用（嵌套组合），双击进入实例编辑。

## 8. 蓝图编辑器（复刻 UE5，对应需求 1/4/5）

### 8.1 视觉复刻清单

- 节点头：分类配色（事件=红、函数=蓝、纯函数=绿、流程控制=灰、变量 Get/Set=无头紧凑样式、插件=紫）、标题 + 副标题（节点名 + 所属类）、左上角图标。
- 引脚色（UE5 标准）：exec=白色三角、bool=红、int=青绿、float=绿、string=洋红、UIObject/对象=蓝、any=灰色；输入引脚带内联默认值编辑框（未连线时可改）。
- 连线：exec 实线白色、数据虚线彩色、贝塞尔曲线 + 运行时流动动画（调试）。
- 画布：暗色网格背景、无限平移缩放、注释框（Comment，可调色、可框选移动内含节点）。

### 8.2 交互复刻清单（UE5 招牌操作）

- 右键呼出节点搜索：模糊匹配 + 分类浏览 + 最近使用 + 上下文（从引脚拖出时只列兼容节点）；Tab 快捷呼出于光标处。
- **从引脚拖出连线松开 → 弹出兼容节点菜单**，选中即建并自动连线。
- 数据线拖到类型不符引脚 → 自动插入转换节点（Cast/ToString/ToNumber…）。
- 断开：右键连线 / Alt+点击引脚；Ctrl+点击已选连线批量断开。
- 框选、拖拽、对齐（选中后自动吸附 + 对齐工具条）、复制粘贴（跨图 / 跨资产可用，剪贴板带 IR 片段格式）。
- 平移：空格拖拽 / 中键；缩放：滚轮（以光标为中心）。

### 8.3 结构面板（My Blueprint）

变量（类型 / 默认值 / 分类 / **「暴露」勾选** → 自动生成 Get/Set 节点 + 脚本 `@expose`）、函数（子图 + 入口 / 出口接口节点，主图出现调用节点）、事件（自定义事件 + 绑定节点内建事件）、注释列表。双击条目跳转 / 打开对应图（图以 tabs 切换，含「＋函数」）。

### 8.4 蓝图检视器（Details）

选中节点 → 显示节点参数（下拉 / 输入 / 滑条）、引脚默认值、节点说明文档；无选中 → 显示当前图 / 函数的接口设置。

### 8.5 保存与校验

Ctrl+S 序列化 IR 到 `.bp.json`；保存前跑校验器，错误列表（点击跳节点）；「编译」概念 = 保存即校验（不引入 UE 的显式编译步骤）。

## 9. 脚本系统（TS + Python，GDScript 风格，对应需求 2）

### 9.1 设计原则

脚本 = 逻辑资产的另一种视图。写法向 GDScript 看齐：**短、声明式、内建全局直接用、注解暴露一切**。语言选择由资产扩展名决定（`.ts` / `.py`），顶部 [蓝图 | 脚本] segmented control 一键切换视图（§10）。

### 9.2 受控写法（可完整映射 IR 的子集）

```ts
// parser.ts —— 逻辑资产示意（受控 TS 子集）
@tool('日志查看器')
class LogViewer extends UILogic {
  @expose({ type: 'string', default: 'com.demo.app' })
  packageName: string                    // → 蓝图变量 + Get/Set 节点

  @on('start')                           // → 事件节点：开始
  onStart(): void {
    ui.title.text = '日志分析'
  }

  @on('btnFetch', 'pressed')             // → 事件节点：UI 按钮 pressed
  async fetch(): Promise<void> {
    const lines = await plugins.phoneLog.read({ mode: 'adb', filter: this.packageName })
    const rows = convert.androidLog(lines).sort(byTime)   // → 转换 + 排序节点链
    ui.list.items = rows
    emit('loaded', rows.length)          // → 发送事件节点
  }
}
```

- 内建全局（两种语言对等）：`ui`（UI 节点访问器）、`vars`、`emit / onEvent`（事件）、`plugins.*`（插件调用，await）、`print`、`convert` / `format`（类型转换与格式化）、`await delay(ms)`。
- 控制流映射：`if/else` → 分支节点；`for..of / while` → 循环节点；表达式 → 纯节点链；函数 → 子蓝图；`emit` → 事件发送节点；`await plugins.x.y()` → 插件节点。
- 超出子集的写法（复杂表达式、闭包、第三方 import）→ 整段折叠为**脚本片段节点**（保留源码 + 声明式引脚），保证往返无损。
- TS 转译：脚本编辑保存时由本地服务 esbuild 转译缓存；运行窗口加载转译产物在沙箱执行。
- Python：同构装饰器（`@tool` / `@expose` / `@on`）+ 同名内建全局（snake_case 别名），Pyodide 执行，`await` 用 `async def`。

## 10. 蓝图 ⇄ 脚本互转机制（D3：单一资产双视图）

```
        蓝图视图（编辑图）                      脚本视图（编辑文本）
              │ serialize                            │ parse（受控子集）
              ▼                                      ▼
   IR  ◀──────────── codegen(TS/Py) ──────────────  IR
（唯一真源，.bp.json 存蓝图资产；脚本资产存源码+加载时解析出同一 IR）
```

- **资产存储**：`.bp.json` 直接存 IR；`.ts` / `.py` 存源码，加载时解析为同构 IR（内存中无差别）。
- 任一视图编辑保存 → 更新 IR → 另一视图标记「已过期」，切到该视图时提示重载（**保存者胜**，不做字符级合并）。
- Codegen 规则：变量 → 类字段 + `@expose`；事件 → `@on` 方法；函数 → 方法 / 子蓝图；节点链 → 语句序列；纯节点链内联为表达式（可读性关键，需表达式合成器）。
- 解析规则：§9.2 受控子集 AST → IR 节点；无法映射节点 → 脚本片段节点。
- 一致性保障：`roundtrip` 测试（延续 v1.1 script-check 思路）：`IR → codegen → parse → IR'` 必须幂等（布局 / 视图状态除外），纳入 CI。

## 11. 事件系统（原信号，对应需求 3）

- **事件面板**（右侧）：选中 UI 节点 → 列出①该节点内建事件（pressed / text_changed…）②其逻辑资产的自定义事件；双击 → 创建 / 跳转对应事件节点或 `@on` 方法（复刻 Godot Signals 面板操作）。
- 节点：自定义事件节点（定义，含多参数）、发送事件节点（emit）、监听节点（onEvent）；事件节点在蓝图中红色事件头样式。
- 运行时事件总线：UI 节点事件 / 系统事件（start / timer / 插件推送）/ 自定义事件；可路由到其它 UI 实例（目标选项：本节点 / 本 UI / 全部实例）。
- 事件队列沿用 v1.1 语义：事件间串行排队保序；RPC 回执与 UI 状态镜像旁路（防死锁）。

## 12. 运行时与运行窗口（对应需求 9）

- F5 运行主 UI / F6 运行当前选中 UI → 新浏览器窗口 `runtime.html?project=…&ui=…`。
- 运行窗口内：UI 树 DOM 渲染 + IR 解释器（Worker，串行事件队列）或脚本沙箱（TS 转译产物 / Pyodide）；插件调用经 HTTP/WS 到本地服务（CLI 桥）。
- **运行时蓝图观察**（v1.1 亮点保留）：编辑器经 WS 反向通道看到运行中节点高亮、exec 连线流动、数据端口实时值（150ms 批量）——编辑器打开该蓝图视图时自动接入。
- 生命周期：`start` 事件（BeginPlay 同义）；`delay` / 异步节点不阻塞后续事件。

## 13. 基础节点库（对应需求 4/6：复刻 UE5 基础 + UI/工具域，可扩展，集中单目录）

### 13.1 目录规划（★ 全部节点集中 `src/nodes/`，扩展只动这个目录）

```
src/nodes/
  index.ts        # 唯一注册入口：import 各分类模块并注册
  spec.ts         # NodeSpec 类型与帮助函数（定义节点的唯一写法）
  flow.ts         # 流程：分支 · 顺序 · ForLoop · While · 门 · 多路复用 · FlipFlop · DoOnce · 序列 · 延时
  events.ts       # 事件：开始 · 自定义事件 · 发送事件 · 监听事件 · 定时器
  variables.ts    # 变量：Get / Set（含暴露变量自动生成）
  math.ts         # 算术 · 比较 · 逻辑 · 随机 · 取整 · 钳制 · Min/Max/Abs
  string.ts       # 拼接 · 格式化 · 分割 · 替换 · 包含 · 正则匹配/提取
  container.ts    # 数组/Map：增删改查 · ForEach · 长度 · 过滤/映射(高阶) · 排序
  convert.ts      # 类型转换：str↔num↔bool · JSON 解析/序列化 · 时间格式化 · Android 日志解析
  ui.ts           # 获取 UI 对象 · 读值/写值 · 显示/隐藏 · Transform 设置 · 列表操作（对象方法节点风格）
  system.ts       # 打印 · 通知 · 剪贴板 · 打开 URL · 当前时间
  dynamic.ts      # 运行时注册通道：插件清单 / 用户自定义节点注入（同一 NodeSpec 结构）
```

### 13.2 NodeSpec（声明式，继承 v1.1 注册表模式）

```jsonc
{
  "id": "flow.branch", "title": "分支", "category": "流程",
  "keywords": ["if", "条件"],
  "inputs":  [{ "id": "exec", "type": "exec" }, { "id": "cond", "type": "bool" }],
  "outputs": [{ "id": "true", "type": "exec" }, { "id": "false", "type": "exec" }],
  "params": [], "pure": false,
  "run": "运行时函数引用（编辑器与运行窗口共用同一定义模块）"
}
```

- 扩展方式：同目录新增一个 `.ts` 分类模块 + `index.ts` 注册一行即完成（配套《节点开发指南》）。
- 插件节点：由插件清单在运行时经 `dynamic.ts` 注册，与内置节点完全同权（同样有 exec in/out + 数据 in/out）。
- 不做清单（明确排除）：模型 / 材质 / 物理 / 动画 / AI 等游戏域节点；UI 的 Transform 保留。

## 14. 插件系统（对应需求 7）

### 14.1 插件分类与清单

```jsonc
// plugins-registry/phone-log.json（内置注册表示意）
{
  "id": "phone-log", "name": "手机日志", "kind": "cli",   // cli=已存在的外部CLI | custom=自定义插件
  "description": "adb 读取手机日志 / 解析 Android 日志文件",
  "detect":  { "cmd": "adb version", "versionRegex": "Android Debug Bridge version ([\\d.]+)" },
  "install": { "strategy": "winget", "args": ["Google.PlatformTools"] },   // winget | npm-global | download-zip | custom-cmd
  "update":  { "latestVersion": "35.0", "source": "registry" },
  "nodes": [
    {
      "id": "phoneLog.read", "title": "读取手机日志",
      "inputs":  [{ "id": "exec" }, { "id": "mode", "type": "select", "options": ["手机读取", "文件读取"] },
                   { "id": "packageFilter", "type": "string", "optional": true },
                   { "id": "files", "type": "file[]", "optional": true, "multi": true }],
      "outputs": [{ "id": "exec" }, { "id": "rows", "type": "LogRow[]" }, { "id": "count", "type": "int" }]
    },
    { "id": "phoneLog.onLine", "title": "手机日志·新行", "kind": "event" }   // 持续流模式
  ]
}
```

- **CLI 插件**（飞书 CLI、adb）：不实现功能本体，只做「检测是否已安装 → 安装命令 → 更新检测」+ 节点封装；安装命令清单化可覆盖（设置界面可改，跨平台差异兜底）。
- **自定义插件**：项目 `plugins/` 或服务端静态目录挂载，manifest 同上 + 可选服务端执行器（`executor.cjs`，入参 / 出参 JSON），服务端负责静态托管与调用入口。
- 注册表来源：内置 `plugins-registry/`（随引擎分发）+ 项目级 + 服务端静态目录，三者合并去重。

### 14.2 插件管理子界面

- 列表：图标 / 名称 / 版本 / 描述 / 来源（内置 · 项目 · 静态目录）/ 配套节点数；点开看节点详情。
- 状态徽标：`未安装`（显示【下载 / 安装】）/ `已安装·最新`（更新按钮**置灰不可点**）/ `可更新`（显示当前版 → 最新版，【更新】可点）/ `自定义`（无安装按钮，显示【重载】）。
- 点击安装 / 更新 → 服务端执行清单命令，实时流式输出到内嵌日志区；完成后重跑 detect 刷新状态。
- 版本判定：`detect.cmd` 解析当前版本 vs `update.latestVersion`；检测失败 = 未安装。

### 14.3 手机日志插件（本期唯一必做插件）

- 节点「读取手机日志」双模式：
  - **手机读取**：`adb [-s serial] logcat -d -v time`（dump 模式）+ 包名过滤；持续流用事件节点 `phoneLog.onLine`（`logcat` 不加 `-d`，行推送走 WS）。
  - **文件读取**：多选日志文件（服务端文件对话框，返回绝对路径数组）；解析每行为结构化 `LogRow`。
- **Android 日志格式解析**：兼容 `MM-DD HH:MM:SS.mmm LEVEL/TAG(PID): msg` 与 `epoch LEVEL/TAG (PID): msg`（logcat `-v time` / 默认格式）；解析失败行保留 raw 字段。
- **多文件时间排序**：全部解析后按时间戳稳定归并排序（同时间按文件序 + 行序 tie-break），输出统一有序行数组。
- v1.1 `server/sources.ts` 的 adb / 文件回放实现可作参考。

## 15. 操作习惯统一清单（验收口径汇总）

| 能力 | 具体要求 |
|---|---|
| 复制粘贴 | 蓝图节点+连线、UI 节点、文件资产、属性值；蓝图 Ctrl+拖拽复制 |
| 撤销重做 | 命令栈覆盖蓝图 / 场景树 / 检视器 / 文件操作；Ctrl+Z / Ctrl+Shift+Z |
| 多窗口 | 所有面板（含蓝图编辑器）可拆出 / 合回，状态实时一致 |
| 运行 | F5 主 UI / F6 当前 UI，独立窗口；运行中蓝图可观察 |
| 快捷键 | 对齐 Godot/UE 习惯，设置内可查可改，冲突检测 |
| 右键菜单 | 画布 / 节点 / 树 / 文件 / 检视器全场景覆盖 |

## 16. 仓库目录规划（v2 最终形态）

```
blueprint-studio/
├─ docs/v2/            # 本方案 · TASKBOARD.md · adr/（架构决策记录）
├─ src/
│  ├─ shell/           # 项目管理器 · dock 系统 · 命令栈 · 快捷键 · 主题 · 多窗口同步
│  ├─ panels/          # 文件系统 · UI 树 · 检视器 · 事件面板 · 控制台 · 插件管理
│  ├─ ui-editor/       # 2D 视口 · 节点创建 · Transform 操作
│  ├─ blueprint/       # 蓝图编辑器（视图 / 交互 / 结构面板 / 蓝图检视器）
│  ├─ script/          # CodeMirror · TS/Py 解析器 · codegen · 注解处理
│  ├─ ir/              # 统一中间表示 · 校验器 · 版本迁移
│  ├─ nodes/           # ★ 基础节点库（§13，集中单目录）
│  └─ runtime/         # runtime.html 入口 · 解释器 · TS/Pyodide 沙箱 · DOM 渲染 · 调试探针
├─ server/             # fs.ts · plugins/（注册表/检测/安装/CLI桥）· static.ts · ws.ts · esbuild 转译
├─ plugins-registry/   # 内置插件清单（phone-log · feishu-cli）
└─ templates/          # 项目模板（空项目 · 日志分析器）
```

## 17. v1.1 资产处置

| 处置 | 内容 |
|---|---|
| 复用经验/参考 | Worker 解释器语义（串行队列+旁路）、ReactFlow 自定义节点、声明式节点注册表、WS 调试协议（trace/pinValue）、adb/文件源处理、roundtrip 测试思路、UIRenderer 编辑/运行共渲染 |
| 由插件体系承接 | 飞书推送（→ 飞书 CLI 插件节点）、RDS 报表（→ 后续自定义插件）、demo 日志源（→ 示例节点） |
| 弃用 | 自研 DSL（script.ts / ScriptView）、IndexedDB 持久化、中间件/插件卡片首页、嵌入式运行面板 |
| 分支策略 | v2 在 `v2` 长分支开发，M2（蓝图闭环）后合回 main 一次，之后 M4、M7 各设合并点；v1.1 始终可从 main 历史回看 |

## 18. 里程碑（垂直切片，每期有明确「不做清单」防失控）

| 里程碑 | 目标（可用线） | 不做 |
|---|---|---|
| **M0 地基** | 项目模型 + FS API + dock 外壳 + 命令栈（撤销重做）+ 项目管理器 | 任何编辑器功能 |
| **M1 UI 闭环** | 拼一个静态 UI → F5 在运行窗口跑起来 | 逻辑 |
| **M2 蓝图闭环** | UE5 风格蓝图编辑 + 解释器 + 绑定 UI 节点 + 事件驱动运行 | 脚本 |
| **M3 脚本(TS)闭环** | TS 脚本编辑运行 + 注解暴露 + 蓝图⇄TS 双视图互转 | Python |
| **M4 Python** | Pyodide 运行 + 装饰器对等 + IR⇄Py codegen | — |
| **M5 事件+调试** | 事件面板/总线完善 + 运行时蓝图观察（高亮/流动/端口值） | — |
| **M6 插件** | 插件管理界面 + CLI 检测/安装/更新 + 手机日志插件（双模式+多文件时序归并）+ 飞书 CLI 清单 | 插件市场/远程注册表 |
| **M7 打磨** | 快捷键全表 · 模板项目 · UI 预制体 · .history 快照 · 文档 · 性能（大图/大列表虚拟化） | 多人协作 |

依赖链：M0 → M1 → M2 → {M3, M5} → M4 → M6 → M7（M3 与 M5 可并行；M6 依赖 M2 即可启动节点封装部分）。

## 19. 风险与对策

| 风险 | 对策 |
|---|---|
| 脚本⇄蓝图双向编辑复杂度最高 | M3 分两步：先「蓝图→TS codegen + @注解暴露」（只读脚本），解析器（TS→IR）第二个任务落地；脚本片段节点兜底保往返无损 |
| ReactFlow 复刻 UE5 视觉的边界 | 节点全自定义 renderer（v1.1 已验证）；连线动画 / 视觉不足时连线层换自绘 SVG |
| 浏览器弹窗被拦截 | 标签页降级模式（打开面板为新 tab） |
| Pyodide 首载 ~10MB | 本地服务托管 + 懒加载 + 进度条；不进关键路径 |
| CLI 安装命令跨平台差异 | 清单 strategy 化 + 设置中可覆盖命令 |
| 多窗口状态一致性 | action 广播按序重放；主窗为布局真源；运行窗口与编辑器只经 WS 通信 |
| 复刻范围失控（无底洞） | 每里程碑「不做清单」+ TASKBOARD DoD 逐条验收 |

## 20. 总验收标准（DoD 总纲）

1. **复刻度**：与 UE5 蓝图编辑器 / Godot 编辑器并排截图对比，§8.1/8.2、§6、§15 清单逐项打勾；交互盲测（会用 UE5/Godot 的人无文档上手）。
2. **互转一致性**：`roundtrip`（IR→TS→IR、IR→Py→IR）幂等测试全绿。
3. **手机日志场景 E2E**：新建项目 → 拼日志查看 UI → 蓝图连「读取手机日志(文件模式, 3 份乱序样本)」→ 运行窗口按时间有序展示。
4. **操作习惯**：撤销重做 / 复制粘贴 / 多窗口拆合全场景无异常（自动化 + 手工清单）。

---

*本方案为 v2 唯一设计真源；任何契约级变更（IR 结构、文件格式、NodeSpec、插件清单）必须走 `docs/v2/adr/` 记录并由 PM-Agent 知会全体。*
