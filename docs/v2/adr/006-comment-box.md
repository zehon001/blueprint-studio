# ADR-006：IRGraph 增补可选 comments 字段（注释框 Comment，T2.7）

> 状态：已采纳（2026-10-17）· 发起：Arch（Blueprint-Agent 持小规模契约扩展权限执行，T2.7 卡附带）· 影响：T2.7 蓝图编辑器 / T2.8 校验器 / T3.5+ 脚本 codegen（只读透传）

## 背景

PLAN §8.1 要求蓝图画布提供 UE5 同款注释框（Comment）：可调色、拖动注释时**完全包含**在框内的节点随注释一起移动。T2.2/T2.3 期间画布只有节点 / 连线两类实体，注释框无处安放；T2.7 交卡前需要一次**小规模契约扩展**（任务卡已授权，PM 知会）。

## 决策

### 1. 契约扩展（src/ir/types.ts，仅追加）

```ts
/** 注释框 bounds（图坐标，像素） */
export interface IRCommentBounds { x: number; y: number; w: number; h: number }

/** 注释框（纯视觉容器，不参与解释执行） */
export interface IRComment {
  id: string;        // 同图内唯一
  text: string;      // 标题栏文本（双击行内编辑）
  color?: string;    // 可选 CSS 颜色串；缺省 = 主题默认灰
  bounds: IRCommentBounds;
}

export interface IRGraph {
  // …既有字段不变…
  comments?: IRComment[];   // 追加：可选；空数组与缺省同义
}
```

- 注释按**图**存放（与节点 / 连线同级），跨图资产各自维护；
- `color` 为可选 CSS 颜色值字符串（预设色板 / 自定义取色器写入）。

### 2. version 不升（仍为 2）

- 新字段**可选**：旧资产（无 comments）读取即无注释，无需迁移；
- 新资产在旧引擎读取：旧 normalize/deserialize 不认识该键——normalizeIR 走宽容洗字段路径会**丢弃未知键**（保持行为不变），不产生损坏；
- 因此不触发 IR_VERSION 升级与迁移链（ADR-001 变更流程的「可选项增补」特例）。

### 3. normalizeIR / serializeIR / deserializeIR（src/ir/validate.ts）

- normalizeIR：`comments` 缺省或空数组**剔除**；每条洗为规范形（id / text / color / bounds，bounds 四字段缺省补 0，color 非字符串剔除）；键序 id → text → color → bounds；
- deserializeIR 结构校验（中文错误）：图级 `comments` 必须为数组；每条必须有非空 `id`、`text`、`bounds`（且 x/y/w/h 四字段必须齐全且为数字）；`color` 若存在必须是字符串；
- validateIR 对 comments **不产生任何 issue**（注释是纯视觉容器，不参与执行语义校验）。

### 4. 选中集命名空间（编辑器内部约定，不入 IR）

注释框复用蓝图选中集（`blueprint-store.selection.nodeIds`），以 `'comment:' + 注释 id` 形式与节点实例 id 共存（如 `'comment:comment_1'`）；Delete → deleteSelection 按前缀分流：注释只删注释（**不级联节点**，UE 同款），节点删除行为不变。

## 编辑器行为口径（UE5 对齐，T2.7 DoD）

| 行为 | 口径 |
|---|---|
| 创建 | 画布右键菜单「添加注释」→ 光标处建默认 360×220 注释框；My Blueprint「注释」分节「＋」兜底新建 |
| 选中 / 移动 | 按下标题即选中（Shift 加选切换）；拖标题移动 bounds，**完全包含**（含边界相切）的节点随注释一起平移——注释 bounds 与节点位置**同一条命令**（label「注释：移动」），撤销一步全还原；相交但不完全包含的节点不动 |
| 实时预览 | 拖动期间内含节点经 ReactFlow `updateNodePositions` 做视图级预览（不写 store / 命令栈），松手才入库 |
| 调整大小 | 拖四角 resize（对角固定、最小 120×44、网格吸附不启用）；内含节点**不**随 resize 移动（UE 同款） |
| 编辑 | 双击标题行内改文本（空文本拒绝）；右键标题 → 预设色板 6 色 + 自定义 color input + 恢复默认色 / 大小重置 / 删除注释 |
| 层级 | 注释图层经 ViewportPortal 渲染在画布视口内 `z-index: -1`——在连线与节点**之下**；注释矩形体 `pointer-events: none`，节点点击 / 框选完全不受注释影响（框选、平移、缩放均穿透） |
| 删除 | 选中注释后 Delete / 右键「删除注释」只删注释；命令 label 均为「注释：…」前缀 |
| 定位 | My Blueprint「注释」分节列出全部图的注释，双击 → 切图 + 选中 + 居中（store.focusComment 请求 + 面板消费） |

## 变更影响

- T2.8（已完成）：normalizeIR / assertIRStructure / serializeIR 增补 comments 处理（本 ADR 同批落地，19 既有用例零回归）；
- T3.5/T3.6（脚本 codegen / 解析器）：codegen 忽略 comments；解析器无需生成注释（后续如需「脚本 → 注释」映射再开新 ADR）；
- T2.5 解释器：无感知（comments 不进执行链路）；
- 无存量资产需迁移。

## 已知取舍

- **框选不含注释**：ReactFlow 的框选（selectionOnDrag）只作用于节点；注释框被框选后随框整体拖动属 UE 深度行为，本卡以「拖标题移动」为 DoD 口径，框选注释留待后续卡（需拦截 RF 选择同步或在交互层合成选择变更）；
- 注释不挡节点：矩形体穿透（pointer-events: none）意味着点击注释空白区域落到画布（呼出菜单 / 取消选中）而非选中注释——与「注释在节点下层」的层级口径一致，选中请点标题栏或经 My Blueprint 定位。
