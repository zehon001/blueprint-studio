# ADR-009：UI 预制体（UINode.prefab 实例引用 / 覆盖合并 / 断开物化，T7.3）

> 状态：已采纳（2026-10-17）· 发起：UIEditor-Agent（T7.3 单卡执行）· 影响：T7.3 渲染器（render.ts）/ UI 编辑 store / UI 树面板 / 检视器 / 文件面板（新建入口）/ 运行窗口（RuntimeApp）；T7.6 性能卡不受影响（dataview.ts 未触及）

## 背景

PLAN §7.4 要求「任意 `.ui.json` 可被其它 UI 实例化引用（嵌套组合），双击进入编辑」。T1.4 在 UI 树右键菜单预留了「保存为预制体」占位（toast 提示 T7.3 接入）。渲染器（src/runtime/render/render.ts）为同步架构（renderUI/updateUI 同步 reconcile DOM），而预制体文件必须经 `GET /api/file` 异步取得——需要裁定「同步渲染 × 异步资源」的接合方式与合并语义。

## 决策

### 1. 契约扩展（src/ir/types.ts，仅追加）

```ts
export interface UINode {
  // …既有字段不变…
  /** 预制体引用（ADR-009）：项目内相对路径，如 'ui/prefabs/list-item.ui.json' */
  prefab?: string;
}
```

- 设有 `prefab` 的节点称为**实例节点**；被引用的 `.ui.json` 称为**预制体**（其 root 为预制体根）；
- **version 不升（仍为 2）**：新字段可选，旧资产读取即无预制体；新资产在旧引擎读取时未知键被宽容丢弃，不产生损坏（与 ADR-006 同款「可选项增补」特例）。

### 2. 合并语义（expandPrefabNode，纯函数）

渲染 / 检视器展示 / 物化统一消费「展开后的有效节点」，规则：

| 字段 | 取值 | 理由 |
|---|---|---|
| `id` | **实例自身 id** | DOM keyed reconcile 以 uid 定位元素，实例自身 id 保证元素引用稳定（updateUI 增量更新不重建） |
| `name` | **实例自身 name** | name 是 `ui.<name>` 访问器的查找键，属实例绑定，改名不应被预制体冲掉 |
| `transform` | **实例自身 transform** | 实例在宿主资产中的位置/尺寸/旋转属实例布局；预制体根 transform 仅作为「保存为预制体」时的初值拷贝 |
| `type` | **预制体根 type** | 结构以预制体为准；实例节点身上的 type 字段是实例化时刻的快照（树面板图标 / schema 兜底用），渲染恒以预制体根实际 type 为准 |
| `props` | `{ ...预制体根.props, ...实例.props }` | **浅覆盖**：实例节点 props 里出现过的键写实例值，其余回落预制体根（属性级覆盖，非深层合并） |
| `theme` | `{ ...预制体根.theme, ...实例.theme }` | 同 props（ADR-005 后 theme 暂不使用，规则先立） |
| `children` | **预制体根.children**（递归展开） | 结构以预制体为准；实例自身 children 在有 prefab 引用时**忽略**（不合并、不追加）。要改结构请打开预制体编辑，或对实例「断开预制体」物化后修改 |
| `events` / `logicAsset` | 实例自身，缺省回落预制体根 | 事件/逻辑绑定属实例装配，预制体根也可给默认绑定 |

预制体根 children 内的节点若也带 `prefab`（嵌套实例化）则**递归展开**（其 props 同样与其引用的预制体合并）。

### 3. 循环引用检测（访问链 + 深度上限，中文错误）

- **访问链检测**：展开时携带「当前展开链上已过的预制体路径」；再次遇到链上同路径即循环——错误形如 `检测到预制体循环引用：a.ui.json → b.ui.json → a.ui.json`；
- **深度上限**：嵌套展开超过 `PREFAB_MAX_DEPTH = 16` 层报 `预制体嵌套超过最大深度（16）：…`；
- 检测发生在**展开期**（渲染器内建，任何渲染路径都不可能无限递归）与**装载期**（运行窗口 load 后 `findPrefabCycle` 全树校验，命中则进入中文错误态；编辑器不阻断打开——占位节点就地显示错误文本，用户仍可打开预制体修复）。

### 4. 同步渲染 × 异步资源：打开时预取 + 缓存（src/ui-editor/prefab.ts）

- **缓存**：模块级 `Map<路径, UIAsset>`（`prefab` 缓存），配 in-flight 去重与失败集合（失败路径不再被渲染路径反复重试；`clearPrefabCache()` 统一重置）；
- **预取时机 = 反射时机**：编辑器 `openUIAsset` 与运行窗口 `RuntimeApp.load` 在装载资产前 `clearPrefabCache()` + `prefetchPrefabs`（BFS：资产树内全部 prefab 路径 + 已取到预制体树内的嵌套路径，全部并行 `GET /api/file`）——因此**每次打开资产 / 运行刷新都会重新拉取，预制体改动自然反射到引用处**（工作区同时只挂载激活 tab，切回引用 tab 即重载重取）；
- **未命中兜底**：渲染器查缓存未命中时渲染**占位节点**（`__prefab_placeholder`，dashed 框 + 中文原因），同时经 `ensurePrefabLoaded` 补拉，成功后回调 `RenderOptions.onPrefabLoad`（新增可选字段）触发调用方 updateUI 刷新——补拉失败不回调（无刷新循环，占位显示「预制体加载失败」）；
- 展开结果是**纯派生视图**，不写回资产：实例节点在资产 JSON 里永远只有自身字段。

### 5. 编辑器行为口径（T7.3 DoD）

| 行为 | 口径 |
|---|---|
| 新建预制体 | 文件面板右键（目录/空白）「新建预制体」→ 输入名 → `ui/prefabs/<名>.ui.json`（目录自动创建，空 UI 模板），复用文件系统域可撤销 |
| 保存为预制体 | UI 树右键「保存为预制体」（原 T7.3 占位转正）：确认名 → 子树写出 `ui/prefabs/<名>.ui.json`（根 = 节点深拷贝；**events / logicAsset 属实例装配，不写入预制体**）→ 本节点转为实例（`prefab` 指向新文件，props/children 清空——属性交由预制体承载，实例覆盖再写回；id/name/transform/events/logicAsset 保留）。预制体文件落盘不走 UI 树命令域（撤销还原实例化，不删文件） |
| 实例徽标 | UI 树实例行显示 `⧉ <文件主干>`（如 `⧉ list-item`），title 为完整路径 |
| 编辑预制体 | 树右键「编辑预制体」/ **双击实例行** → 打开该 `.ui.json` 为新 UI tab |
| 检视器 | 选中实例节点显示「预制体」区（路径 + 「编辑预制体」/「断开预制体」）；属性行走既有 schema——单选时 schema 与**显示值**取自展开后的有效节点（预制体根 type 的 schema），**修改即写实例自身 props（覆盖）**，入命令栈可撤销 |
| 断开预制体 | 「检视器：断开预制体」单命令：以展开结果物化——type/props/theme/events/logicAsset 冻结为当前有效值，children = 预制体根子树深拷贝（全新 id + 树内唯一名；**嵌套实例保留其自身 prefab 引用**），删除 `prefab` 字段。预制体未缓存（如文件已删）拒绝并提示。撤销完整还原引用 |
| 结构约束 | 实例节点拒收子节点：树右键「添加子节点」置灰、拖拽 inside 落区拒绝（中文原因「实例节点结构以预制体为准」）；复制实例 = 复制引用（同预制体再实例化） |

### 6. 运行态（RuntimeApp）

load 阶段与编辑器同款预取 + `findPrefabCycle` 校验（命中 → 中文错误态 + 重试按钮）；就绪后 renderUI 传 `onPrefabLoad`，补拉完成即 `updateUI` 刷新。运行窗口无编辑能力，缓存生命周期 = 一次 load（「刷新」按钮重走 load 重新拉取）。

## 变更影响

- 渲染器（render.ts）：reconcile 前对每个节点做 `prefab` 展开替换；`applyCommon` 增补 `data-prefab` 标记；`nodes.ts` / `dataview.ts` 未改动（T7.6 文件边界不受影响）；
- store / RuntimeApp：装载前各插入一段预取逻辑（失败静默为占位，不阻断打开）；
- 无存量资产迁移；IR_VERSION 不变；
- 已知取舍：① 预制体子树节点的 id 在 DOM 上可能跨实例重复（同一预制体多实例）——reconcile 按宿主分流不受影响，视口拾取实例内部子节点时选中可能不落树（实例内部节点本就不在宿主资产树内，属预期）；② 实例 props 浅覆盖不做深层合并（listColumns 等结构化属性覆盖即整体替换）；③ 编辑器对循环引用不阻断打开（就地占位显示中文错误），运行窗口阻断。
