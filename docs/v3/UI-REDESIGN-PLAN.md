# UI 现代化改造实施方案（UI-REDESIGN）

> 状态：**已获用户确认**（2026-10-19），待实施
> 目标分支建议：从 `fix/v3.1-requirements-consistency`（当前 HEAD `f558396`）切出 `feat/ui-redesign`
> 工程根目录：`/Users/azusako/Project/Common/blueprint-studio`
> 本文档自包含：新会话无需背景上下文，按阶段执行即可。

---

## 0. 任务目标

把 v3.1 的界面从「Godot 式平灰」升级为「Linear 式近黑现代专业 IDE」，同时**保留 UE5 蓝图节点的专业骨架**（引脚色 / 节点头分类色 / 连线语义不变）。

用户明确认可的三条决策：

1. 风格：「Linear 式近黑现代风 + 保留蓝图专业骨架」
2. 节奏：六个阶段一次做完
3. 字体：引入 Inter（跨平台一致）

### 验收总标准

- 视觉：项目管理器 / 编辑器外壳 / 文件系统 / 检视器 / 节点弹窗 / 画布 六处观感统一、现代、有层次
- 工程：`npm run typecheck` 0 错；全部 `*.test.ts` 通过；`npm run build` 绿；交互逻辑与快捷键行为不变
- 主题：`src/shell/theme/theme.test.ts` 保持绿（CSS 与 tokens.ts 严格一一对应）

### 现状问题（改造依据）

- 平灰三阶底色（#191919 / #1e1e1e / #252525）几乎没有层次；3px 圆角
- Unicode 字符当图标：`▤ ▸ ⊞ ⚙ × ▭ ⇧ ▶ ⚡ ƒ ∑`，以及 BP/UI 文字徽章
- 节点添加弹窗 = 贴光标弹的 240px 窄列表，纯文字行 + 蓝点
- 文件树 = 灰方块 + 文本徽章，无文件类型语义、无面包屑、无悬停动作
- 检视器 = 键值对平铺，无分组卡片、无控件规范
- 无状态栏、无图标库、无统一菜单/对话框/toast

---

## 1. 硬约束（必须遵守）

1. **不改交互逻辑**：拖拽连线、框选、命令栈（`src/shell/commands`）、快捷键（`src/shell/keymap`）、SSE 文件监视、撤销/重做语义全部保持。只改视觉层与组件外壳（props 契约不变）。
2. **token 名字不变**：只在 `theme.css` 与 `tokens.ts` **同步修改值**；可新增 token；`theme.test.ts` 校验同名值一致，改色必须两处同步。
3. **蓝图层语义色保留**：`--pin-*`、`--node-head-*`、`--edge-exec` 等蓝图语义色属于“专业骨架”，不要换成通用色（只允许微调明度）。
4. **测试选择器**：重命名 CSS class 前先 `grep -r "<class名>" src tests`；若被测试引用则保留 class 名或在同一提交内更新测试。
5. **运行环境**：前端 `npm run dev`（:5173）、后端 `npm run server`（:8790）。**8787 端口被本机其他代理占用，勿用**。
6. **每阶段结束必须**：
   ```bash
   npm run typecheck
   npm run roundtrip
   npx tsx --test src/shell/theme/theme.test.ts src/panels/inspector/inspector.test.ts src/shell/dock/dock.test.ts 2>/dev/null || true
   npm run build
   ```
   全量测试命令（数量大，提交前跑）：
   ```bash
   npx tsx --test $(find src server tests -name '*.test.ts')
   ```

---

## 2. 设计系统 v2（P0 的核心产出）

### 2.1 调色板（theme.css + tokens.ts 同步替换）

| Token | 现值（Godot 灰） | 新值（Linear 近黑） | 说明 |
|---|---|---|---|
| `--bg-app` | `#191919` | **`#0B0C0E`** | 应用最底 |
| `--bg-panel` | `#1e1e1e` | **`#111215`** | 面板底 |
| `--bg-panel-header` | `#252525` | **`#15171B`** | 面板标题栏 |
| `--bg-input` | `#292929` | **`#1B1D23`** | 输入框 / 控件底 |
| `--bg-canvas` | `#141414` | **`#0E0F12`** | 蓝图/UI 画布底 |
| `--border` | `#2e2e2e` | **`#23262E`** | 常规分隔 |
| `--border-strong` | `#3f3f3f` | **`#333845`** | 强调分隔 / 输入描边 |
| `--text` | `#e0e0e0` | **`#E6E8EC`** | 主文本 |
| `--text-dim` | `#9e9e9e` | **`#9CA3AF`** | 次级文本 |
| `--text-disabled` | `#5c5c5c` | **`#5B6270`** | 禁用 |
| `--accent` | `#4f8cc9` | **`#5B8CFF`** | 单一强调色 |
| `--accent-hover` | `#63a0dc` | **`#7BA3FF`** | |
| `--selection` | `rgba(79,140,201,.35)` | **`rgba(91,140,255,.14)`** | 选中底（大面积用淡） |
| `--focus-ring` | `#7fb2e5` | **`#5B8CFF`** | 焦点环 |
| `--success` | `#67c06b` | **`#3ECF8E`** | |
| `--warning` | `#e2b34a` | **`#F5B544`** | |
| `--error` | `#e05c5c` | **`#F87171`** | |

新增 token（两处同步）：

```css
--bg-elevated: #191B21;                  /* 浮层/弹窗/菜单底 */
--bg-hover: rgba(255,255,255,0.045);     /* 行/按钮悬停 */
--bg-active: rgba(255,255,255,0.075);    /* 按下/激活 */
--shadow-popover: 0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px var(--border);
--shadow-dialog: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px var(--border);
--radius-lg: 12px;                       /* 现有 sm→4px, md→8px */
--dur-fast: 120ms;                       /* 悬停 */
--dur-normal: 160ms;                     /* 浮层进出 */
```

圆角修改：`--radius-sm: 3px → 4px`，`--radius-md: 6px → 8px`，新增 `--radius-lg: 12px`。

### 2.2 蓝图层微调（保留语义，仅调质感）

| Token | 现值 | 新值 |
|---|---|---|
| `--node-bg` | `#1f1f1f` | **`#181A20`** |
| `--node-border` | `#0f0f0f` | **`#2A2D35`** |
| `--node-var-bg` | `#262626` | **`#1C1F26`** |
| `--node-var-border` | `#3d3d3d` | **`#2E323C`** |
| `--node-selected` | `#d8a03f` | **`#5B8CFF`**（与强调色一致；琥珀仅保留给注释框可选色） |
| `--bp-grid-dot` | `#333333` | **`#1E2128`** |
| `--edge-selected` | `#d4e157` | **`#5B8CFF`** |

**不改**：`--pin-exec/bool/int/float/string/object/any`、`--node-head-event/function/pure/flow/plugin`、`--edge-exec`、`--edge-data-default`。

### 2.3 字体与排版

- 安装 `@fontsource-variable/inter`；在三个入口 import：
  - `src/shell/main.tsx`、`src/shell/project-manager/main.tsx`、`src/runtime/main.tsx`
  - 追加：`import '@fontsource-variable/inter'`（theme.css 之后 import）
- `--font-ui` 改为：`'Inter Variable', 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif`
- `--font-mono` 保持现有栈（JetBrains Mono → Consolas 回退），可选装 `@fontsource-variable/jetbrains-mono`
- 数字/ID/统计使用 `font-variant-numeric: tabular-nums`
- 字号不变（11/12/13/15），但增大行距：面板行 28px、菜单项 30px、检视器行 28px

### 2.4 全局基线（新建 `src/shell/theme/base.css`）

theme.css 只允许声明 token（其文件头有明确约定），因此新增 `base.css` 并在三个入口于 theme.css 之后 import：

```css
/* 全局元素基线：字体、焦点、滚动条、选中、按钮/输入 reset */
html, body { font-family: var(--font-ui); background: var(--bg-app); color: var(--text); }
:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
::selection { background: rgba(91,140,255,0.35); }
/* 细滚动条：8px、hover 才显色 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #2A2D35; border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: #3A3F4B; background-clip: padding-box; }
/* 全局过渡约定（只给颜色/背景/边框加，不给布局加） */
```

### 2.5 布局尺寸调整

| Token | 现值 | 新值 |
|---|---|---|
| `--panel-header-h` | 28px | **32px** |
| `--toolbar-h` | 36px | **40px** |
| `--tab-h` | 30px | **32px** |

（改完检查 DockShell / MyBlueprint / 各处硬编码高度是否引用这些 token；若硬编码则改为引用。）

### 2.6 字体/依赖安装（一次性）

```bash
npm i lucide-react cmdk radix-ui @tanstack/react-virtual sonner @fontsource-variable/inter
```

说明：
- `radix-ui` 为聚合包（含 Dialog/DropdownMenu/ContextMenu/Select/Switch/Tooltip/Popover/Slider/ScrollArea）
- **不引入**：Leva（调试面板取向，不适合 schema 驱动的复杂检视器）、react-arborist（会迫使重写 1036 行文件系统逻辑）、TanStack Table（当前无资产表格视图需求）

---

## 3. 图标系统（P1）

### 3.1 新建 `src/shell/ui/` 目录（通用 UI 原语）

```
src/shell/ui/
├── Icon.tsx          # <Icon icon={Folder} size={14}/>：统一 14px、strokeWidth 1.75、currentColor
├── IconButton.tsx    # 图标按钮：variant(ghost|outline|danger)、size(sm|md)、Tooltip + aria-label
├── Menu.tsx          # Radix DropdownMenu/ContextMenu 封装：icon+label+shortcut、分组、danger
├── Dialog.tsx        # Radix Dialog 封装：title/footer、进出动画
├── Field.tsx         # 检视器控件原语（见 P4）
└── icons.ts          # 中央图标映射
```

### 3.2 图标映射表（`src/shell/ui/icons.ts`）

文件类型（用于文件树/标签页/面包屑）：

| 类型 | Lucide 图标 | 色 |
|---|---|---|
| 文件夹 | `Folder` / `FolderOpen` | `--text-dim` |
| 项目根 | `Package` | `--accent` |
| `.bp.json` 蓝图 | `Workflow` | `#F5B544` |
| `.ui.json` 界面 | `LayoutGrid` | `#3ECF8E` |
| `.ts` / `.py` 脚本 | `FileCode2` | `#5B8CFF` |
| 样式（styles） | `Palette` | `#B48BFF` |
| 元素（elements） | `Box` | `#FF9F6E` |
| 插件（plugins） | `Plug` | `#6EE7F9` |
| 图片 | `FileImage` | `#3ECF8E` |
| Markdown | `FileText` | `--text-dim` |
| `project.json` | `FileJson2` | `#F5B544` |
| 其余 | `File` | `--text-dim` |

工具栏与常用操作：

| 位置 | 图标 |
|---|---|
| 运行 / 运行当前 / 停止 | `Play` / `PlayCircle` / `Square` |
| 调试 | `Bug` |
| 保存 | `Save`（状态点：`Circle` 实心） |
| 撤销 / 重做 | `Undo2` / `Redo2` |
| 面板 / 重置布局 / 设置 | `LayoutDashboard` / `RotateCcw` / `Settings` |
| 面板头：最大化/关闭/拖拽 | `Maximize2` / `X` / `GripVertical` |
| 树折叠 | `ChevronRight`（展开时 `rotate(90deg)`） |
| My Blueprint：变量/函数/事件/注释 | `Braces` / `FunctionSquare` / `Zap` / `MessageSquare` |
| 添加 / 更多 / 搜索 / 勾选 | `Plus` / `MoreHorizontal` / `Search` / `Check` |
| 检视器：重置 / 信息 | `RotateCcw` / `Info` |
| 菜单子项箭头 | `ChevronRight` |

### 3.3 替换清单（grep 已确认含 Unicode 字形的文件）

必须清除 `▤ ▸ ▾ ⊞ ⚙ × ▭ ⇧ ▶ ⚡ ƒ ∑` 等作图标用途的字符：

- `src/shell/Toolbar.tsx`
- `src/shell/dock/DockShell.tsx`（面板头 ⊞ × 等）
- `src/shell/workspace/BlueprintTab.tsx`、`src/shell/workspace/UITab.tsx`
- `src/shell/settings/SettingsModal.tsx`
- `src/panels/file-system/FileSystemPanel.tsx`（树图标、徽章）
- `src/panels/inspector/*.tsx`（VariableSection、ElementSettingsSection、ElementInstanceSection、FlexLayoutSection、StyleClassSection、InspectorPanel）
- `src/panels/library/LibraryPanel.tsx`、`StyleLibraryPanel.tsx`
- `src/panels/events/EventsPanel.tsx`
- `src/panels/scene-tree/SceneTreePanel.tsx`、`AddNodeMenu.tsx`
- `src/panels/plugin-manager/PluginManagerPanel.tsx`
- `src/blueprint/my-blueprint/*`（My Blueprint 左面板）
- `src/blueprint/interaction/NodeSearchMenu.tsx`
- `src/runtime/RuntimeApp.tsx`

规则：图标一律 `<Icon icon={X} />` 或 `<IconButton>`；文字内嵌 emoji（如模板描述）可保留；`BP`/`UI` 文字徽章改为“小图标 + 可选文字”chip。

---

## 4. 阶段任务

### P0 设计基座

**文件**：`src/shell/theme/theme.css`、`src/shell/theme/tokens.ts`、新增 `src/shell/theme/base.css`、三个入口 `main.tsx`

**步骤**：
1. 按 §2.1/2.2/2.5 同步替换 token（CSS 与 TS 必须完全一致）
2. `tokens.ts` 的 `TOKENS` 增加新 token（`--bg-elevated` 等），分组常量无需改
3. 新建 `base.css`（§2.4），三个入口在 theme.css 后 import；同时 import Inter
4. 全局检查硬编码颜色：`grep -rn "#[0-9a-fA-F]\{6\}" src --include="*.css" | grep -v theme.css | head -40`，逐一改为 `var(--...)`（本轮至少保证本次触及的组件无硬编码）
5. 运行 theme.test 与 typecheck

**验收**：应用启动整体已是近黑冷调；`theme.test.ts` 绿；hover/focus/滚动条观感统一。

---

### P1 图标系统（§3）

**验收**：全项目（grep 清单）无 Unicode 图标字符；文件树/工具栏/面板头/菜单全部为 Lucide 图标；`IconButton` 带 Tooltip 与 aria-label。

---

### P2 命令面板 + 统一菜单

**文件**：
- 新增 `src/shell/ui/CommandPalette.tsx`、`src/shell/ui/Menu.tsx`、`src/shell/ui/Dialog.tsx`
- 改造 `src/blueprint/interaction/NodeSearchMenu.tsx` + `interaction.css`
- 迁移 `src/panels/file-system/Menu.tsx`（右键菜单）→ `ui/Menu`
- 迁移连线右键菜单（NodeSearchMenu.tsx 内 `EdgeContextMenu`）→ `ui/Menu`
- 迁移 `src/panels/scene-tree/AddNodeMenu.tsx`
- 接入 `sonner`：shell main.tsx 挂 `<Toaster theme="dark" position="bottom-right" />`；`onFsNotice` 内部改为 `toast.success/error`（对外 API 不变）

**NodeSearchMenu 规格**：
- 锚定右键位置，宽 420px，最大高 420px，底 `--bg-elevated` + `--radius-lg` + `--shadow-popover`
- 顶部搜索框：Search 图标 + 输入，12px；保留“名称/关键词/首字母”匹配逻辑（**不动**）
- 分组标题：11px `--text-dim` 大写字距；行 30px：类别色方块（16px，圆角 4，图标白色）+ 标题 12px + 副标题 11px（`spec.id`）+ 右侧快捷键/徽章
- 高亮态：`--bg-hover` + 左侧 2px 强调条；键盘 ↑↓ Enter Esc 不变
- 位置裁切：改用 Radix Popover/Popper 的碰撞检测（替代 `clampMenuPosition` 的粗裁剪）

**⌘K 命令面板（新增）**：
- `cmdk` 实现，居中 560px 浮层，搜索框 + 分组（刚使用 / 节点 / 文件 / 命令）
- 接入 `src/shell/commands` 与 `keymap` 注册表（只读调用，不改逻辑）：运行、保存、撤销/重做、切换面板、打开最近文件
- 节点项直接调用现有“添加节点”流程（与 NodeSearchMenu 共用 pick 逻辑，抽公共函数）
- 全局快捷键：`Cmd/Ctrl+K` 打开；`Esc` 关闭（在 keymap 里注册）

**统一菜单规格**（Radix ContextMenu/DropdownMenu）：
- 项高 30px：左图标 14px + label + 右侧快捷键 `--text-dim` 11px；危险项红色；分隔线 `--border`；子菜单 ChevronRight
- 自动避让视口边缘（解决当前菜单被面板裁切）
- 文件树菜单项保持现有语义（打开/历史快照/重命名/复制/删除/新建…），仅换皮

**验收**：右键画布任意位置（含面板边缘）菜单完整可见；⌘K 可用；节点添加流程与旧行为一致；所有菜单可键盘操作。

---

### P3 文件系统面板

**文件**：`src/panels/file-system/FileSystemPanel.tsx`、`styles.css`、`menu.css`（保留 PromptModal 样式）、`Menu.tsx`（已迁移）

**规格**：
- 行高 **28px**；缩进每级 14px；行内 padding 8px
- 图标：`fileIconFor(name)`（§3.2），14px；文件夹展开用 `FolderOpen`
- 徽章：BP/UI 由“文字”改为 16px 彩色小图标 chip（Workflow/LayoutGrid），title 提示类型
- 悬停：`--bg-hover`；行尾出现 `MoreHorizontal` 图标按钮（打开同一右键菜单）
- 选中：`--selection` 底 + 左侧 2px 强调条；键盘上下移动可选（如已有实现则换皮）
- 拖拽目标：1px 强调色虚线圈 + `--selection` 淡底
- 面板头：项目名 → 面包屑 `项目 / logic / main.bp.json`（当前选中文件路径），右侧刷新按钮为 IconButton
- 空态：`FolderOpen` 48px + 标题 + 说明 + 主按钮（新建/导入）
- PromptModal（新建/重命名）：`ui/Dialog` 皮，宽 400px，主按钮强调色
- 行内重命名输入框：12px 等宽、强调色描边
- 大目录虚拟化（>300 行）：把可见行扁平化后用 `@tanstack/react-virtual` 渲染；保留展开状态与拖拽交互；若风险高可后置为独立提交

**验收**：打开项目，文件类型一眼可辨；悬停/选中反馈明确；右键菜单不被裁切；重命名/新建/删除/撤销全部正常（这些有命令栈集成，务必回归）。

---

### P4 检视器（Inspector）

**文件**：`src/panels/inspector/InspectorPanel.tsx`、`PropEditors.tsx`、各 Section、`inspector.css`、新增 `src/shell/ui/Field.tsx`

**规格**：
- 面板头：标题 + 类型 chip + 选中对象面包屑（如 `日志查看器 · 开始节点`）
- 分区 = 可折叠卡片：卡片 `--bg-panel` 底、`--border` 描边、`--radius-md`、标题 12px 半粗 + 图标 + 计数 pill；间距 8px
- 控件行 28px：label 左 12px `--text-dim`（宽 96px 或 40%），control 右；行 hover 出现“重置”蓝点（仅当值 ≠ 默认值时；无默认值的字段不显示）
- 控件规范（`ui/Field.tsx`）：
  - `NumberField`：12px 等宽数字 + 左右拖拽调节（pointer capture；步长 1，Shift×10，Alt×0.1），Tab 可输入
  - `TextField`：`--bg-input` 底、focus 强调色描边
  - `SelectField`：Radix Select，菜单浮层样式同统一菜单
  - `SwitchField`：Radix Switch，36×20，开=强调色
  - `ColorField`：12px 色块 + hex 文本 + 原生取色器（Popover）
  - `AssetField`：缩略图（无图用类型图标）+ 名称 + 浏览按钮
  - `CodeField`：等宽 + 已有 CodeMirror 时保持不动，只换皮
- 多选状态：显示共同值 / “多个值”占位，编辑作用于全部（若现有逻辑不支持则跳过，不改逻辑）
- 空态：`MousePointerClick` 图标 + “选中画布中的面板或节点查看属性”

**验收**：任意选中节点/面板，检视器分区清晰、行距一致、重置点正确出现；已有 inspector.test.ts 全绿。

---

### P5 外壳（顶栏 / 面板 / 标签 / 状态栏 / 项目管理器 / 运行/设置）

**文件**：`src/shell/Toolbar.tsx`、`src/shell/dock/DockShell.tsx` + `dock.css`、`src/shell/workspace/*Tab.tsx`、新增 `src/shell/StatusBar.tsx`（并在 shell 布局挂载）、`src/shell/project-manager/*` + `project-manager.css`、`src/runtime/main.tsx` + `runtime.css`、`src/shell/settings/*`、`src/shell/settings/settings.css`

**顶栏规格**（40px）：
- 左：Logo（`Boxes` 图标 + 字标 13px 半粗）+ 项目名 chip（Package 图标 + 名称，hover 可见切换入口）
- 中：主操作组：**运行**（实心强调按钮，Play 图标）、运行当前（outline）、调试（ghost）、分隔线、保存（ghost，右侧状态点：绿色=已保存 / 琥珀=未保存）
- 右：撤销/重做 IconButton（带 Tooltip+快捷键）、面板 Dropdown（LayoutDashboard）、重置布局 IconButton、设置 IconButton
- 所有按钮 hover `--bg-hover`，间距 8px，分组分隔线 16px 高

**Dock 面板（dock.css + DockShell.tsx）**：
- 面板头 32px：标题 12px 半粗、右侧操作（最大化/关闭）**悬停才出现**，拖拽区 GripVertical 光标
- 标签：活动标签 12px `--text` + 底部 2px 强调色；非活动 `--text-dim`；hover `--bg-hover`；关闭按钮 hover 才显
- 分隔条 4px：hover/拖拽时强调色
- 面板内容区背景 `--bg-panel`；画布面板用 `--bg-canvas`
- 面板空态统一：图标 40px + 标题 + 说明

**状态栏（新增，24px，置于应用底部）**：
- 左：`Circle`（8px）后端连接状态点 + 文案（在线=绿/离线=红，title 显示 WS 状态）+ 项目名
- 中：当前活动资产路径（等宽 11px）
- 右：节点/连线计数、缩放百分比（订阅现有 store，只读）
- 需在 `src/shell/main.tsx` 的布局容器底部挂载；不得影响 dock 高度计算（检查 flex 布局）

**项目管理器**：
- 页头：Logo + 服务状态 chip（`Circle` 点 + 文案）+ 版本号
- 三栏卡片现代化：卡片 `--bg-panel`、`--radius-lg`、hover 提升（描边变亮 + 轻阴影）；模板卡片选中态 = 强调色描边 + 淡底 + 右侧 `Check` 图标
- 最近项目空态：`FolderOpen` 图标 + 说明
- 输入框统一 `--bg-input` + focus 强调环；主按钮实心强调、次按钮 outline
- 导入项目区：路径输入等宽字体 + 说明 11px `--text-dim`

**运行视图/独立窗口**（runtime）：
- 与主壳同一 token；窗口 chrome 圆角 12、标题栏 32px、关闭/拆窗 IconButton
- 运行空态、错误态样式统一

**设置弹窗**：`ui/Dialog` + 分区表单，与检视器控件一致

**验收**：整屏截图（项目管理器 / 编辑器 / 运行视图）；工具栏不换行；状态栏数据实时更新；面板拖拽/最大化/关闭正常。

---

### P6 蓝图画布 / 节点 / My Blueprint

**文件**：`src/blueprint/view/styles.css`、`src/blueprint/my-blueprint/*`、`src/panels/scene-tree/*`（节点库）、`src/blueprint/interaction/interaction.css`

**规格**：
- 节点卡：`--radius-md`（8px）圆角；1px `--node-border`；标题 11px 半粗 + 分类色左侧 3px 竖条（保留 UE 分类色头，但降低饱和度 8%、提升文字对比）；body 12px；节点阴影 `0 4px 12px rgba(0,0,0,.35)`
- 选中：2px `--node-selected` 描边 + 外发光 `0 0 0 4px rgba(91,140,255,.18)`
- 运行中脉冲：当前执行节点外发光呼吸动画 1.2s（保留现有高亮逻辑，仅换视觉）
- 引脚：10px；hover 放大 1.3 + 环；引脚值 chip：11px 等宽、`--bg-elevated` 底、1px 描边（不再用绿色底）
- 连线：2px 圆角贝塞尔；exec 白色 85% 透明度；数据线按引脚色 75%；hover/选中强调色 + 光晕；执行流动虚线保留现有动画
- 画布：点阵 `--bp-grid-dot`（更淡）+ 轻微径向渐晕；MiniMap：`--bg-panel` 底、8px 圆角、1px 描边、节点色点 4px
- 注释框：标题栏 24px、半透明底、圆角 8px
- My Blueprint 左面板：分组头（图标 14px + 标题 12px + 计数 pill 11px）可折叠；行 28px；变量行显示类型 chip（用对应 `--pin-*` 色）；“＋”改为悬停出现的 ghost IconButton；空态 11px `--text-dim`
- 节点库面板（scene-tree）：搜索框置顶（Search 图标）；节点条目 30px：类别色图标块 + 标题 + 拖拽手柄 GripVertical（hover 显示）

**验收**：打开模板项目，100% 缩放下节点可读性、层级、选中反馈明显提升；连线与引脚语义不变；画布交互（框选/拖拽/缩放）无回归。

---

## 5. 执行顺序与提交建议

1. 建分支：`git checkout -b feat/ui-redesign`（基于 `fix/v3.1-requirements-consistency`）
2. 按 P0 → P6 顺序执行；**每完成一个阶段**：
   - 运行 §1 的检查命令（typecheck + 关键测试 + build）
   - 用浏览器截图对比（项目管理器 / 编辑器 / 文件树 / 节点菜单 / 检视器 / 运行视图）
   - `git add -A && git commit -m "ui(P0): 设计基座——Linear 近黑 token / Inter / 全局基线"`（每阶段一个提交）
3. 全部完成后跑全量测试：`npx tsx --test $(find src server tests -name '*.test.ts')`
4. 最终整屏截图留档；更新本文件状态为「已完成」并补充偏差说明

## 6. 风险清单

| 风险 | 应对 |
|---|---|
| `theme.test.ts` 校验 CSS↔tokens.ts 严格一致 | 每次改色**同时**改两处；改完立即跑该测试 |
| 测试引用 CSS class / 文案选择器 | 改名前 grep tests；优先保留 class 名，只改样式值 |
| Dock 尺寸 token 变化引发布局溢出 | 改完逐面板检查最大化/拖拽/小屏；必要时面板内用 min-height |
| Radix Popover 在 React Flow 画布内定位漂移 | 统一挂到 `document.body`（portal），坐标用视口坐标 |
| 文件树虚拟化破坏拖拽/重命名 | 虚拟化单独提交；若 30 分钟内无法稳定则回退，保留非虚拟化版本（行数不大时无碍） |
| sonner 与现有 toast/notice 重复 | 只保留一处：`onFsNotice` 内部改 sonner，删除旧通知 UI |
| 状态栏挤压 dock 高度 | 用 flex 列布局：状态栏固定 24px，dock 区 flex:1 min-height:0 |
| 大范围视觉改动导致 e2e 选择器失效 | 保留语义 class 与 aria-label；e2e 主要走 role/text，尽量不改文案 |

## 7. 开工前自检（新会话执行）

```bash
cd /Users/azusako/Project/Common/blueprint-studio
git status                     # 应干净；当前分支 fix/v3.1-requirements-consistency
npm run server &               # 若未运行（:8790）
npm run dev &                  # 若未运行（:5173）
npm run typecheck              # 基线全绿
```

**本方案已获用户批准，可直接开工；遇到与本文档冲突的现状（如文件已重构），以代码为准并在完成后更新本文档。**
