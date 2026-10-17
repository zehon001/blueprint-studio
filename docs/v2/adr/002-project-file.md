# ADR-002：项目文件格式（project.json / UI 资产）

| 状态 | 日期 | 关联卡 | 影响范围 |
|---|---|---|---|
| 已接受 | 2026-10-17 | T0.1 | `server/fs.ts`（T0.2）、`src/ui-editor/`（T1.1）、`src/shell/project-manager/`（T0.6）、`src/runtime/`（T1.6） |

## 1. 决策内容

沿 Godot 习惯：**文件夹即项目，资产即文件**（PLAN §4.1）。

- 项目 = 一个文件夹 + 根目录 `project.json`；所有资产是普通文件，可直接复制 / 移动 / 重命名实现共享。
- UI（场景）资产 = `*.ui.json`，内容是一棵 UI 节点树（`UIAsset` / `UINode`）。
- 逻辑资产 = `.bp.json`（IR 序列化，见 ADR-001）或 `.ts` / `.py`（源码即存储）。
- 目录约定（服务端 FS API 与模板脚手架按此校验）：

```
MyTool/
  project.json        # 项目描述（ProjectFile）
  ui/                 # UI 资产
    main.ui.json
  logic/              # 逻辑资产（可放子目录）
    main.bp.json
    parser.ts
    helper.py
  assets/             # 图片等静态资源（服务端静态托管）
  plugins/            # 项目级自定义插件（可选）
  .history/           # 自动快照（git ignore，T7.4）
```

- `project.json.plugins`：键 = 插件 id，值 = 是否启用；这是「项目启用了哪些插件」的唯一真源（清单本体见 ADR-004）。
- `project.json.mainUI` = F5 运行的入口 UI；F6 运行当前选中 UI。

## 2. 结构定义

类型真源：[src/ir/types.ts](../../../src/ir/types.ts)。

| 类型 | 对应文件 | 说明 |
|---|---|---|
| `ProjectFile` | `project.json` | 项目描述：name / mainUI / engineVersion / plugins |
| `UIAsset` | `ui/*.ui.json` | UI 资产根：version / name / root |
| `UINode` | 树节点 | id / name（树内唯一）/ type / transform / theme / props / events / logicAsset / children |
| `UITransform` | UINode.transform | position / size / rotation / anchors（骨架） |

要点与边界：

- `UINode.name` 在 **同一 UI 资产树内唯一**，是脚本 `ui` 访问器的查找键（§4.2：`ui.list` = 绑定节点子树中 name 为 `list` 的节点）。
- `UINode.logicAsset` 挂逻辑资产（相对项目根路径）；一个节点至多挂一个逻辑资产。
- `UINode.type` / `props` / `theme` 的**属性 schema**（每个 UI 节点类型有哪些属性、类型、默认值、分组）由 T1.1（`src/ui-editor/schema/`）声明式定义，本 ADR 只固化**容器结构**（骨架），不锁属性集合。
- `UITransform.anchors` 为骨架（`Record<string, number>`），具体锚点语义由 T1.1 细化后替换为具体类型（届时走 ADR 修订）。
- UI 预制体（T7.3：`.ui.json` 嵌套实例化）不改本结构，引用字段的加入走 ADR 扩展 `UINode`。

## 3. 示例

```jsonc
// MyTool/project.json
{
  "name": "日志分析器",
  "mainUI": "ui/main.ui.json",
  "engineVersion": "0.2.0",
  "plugins": { "phone-log": true }
}
```

```jsonc
// MyTool/ui/main.ui.json
{
  "version": 2,
  "name": "main",
  "root": {
    "id": "ui_root", "name": "root", "type": "vbox",
    "transform": { "position": { "x": 0, "y": 0 }, "size": { "w": 960, "h": 640 }, "rotation": 0 },
    "theme": { "padding": 8 },
    "props": { "spacing": 4 },
    "children": [
      {
        "id": "ui_title", "name": "title", "type": "label",
        "transform": { "position": { "x": 0, "y": 0 }, "size": { "w": 960, "h": 32 }, "rotation": 0 },
        "theme": { "fontSize": 18 },
        "props": { "text": "日志分析" },
        "children": []
      },
      {
        "id": "ui_list", "name": "list", "type": "list",
        "transform": { "position": { "x": 0, "y": 40 }, "size": { "w": 960, "h": 560 }, "rotation": 0 },
        "theme": {},
        "props": {},
        "logicAsset": "logic/main.bp.json",   // 绑定逻辑资产（§4.2）
        "events": ["selectionChanged", "doubleClicked"],           // 关注的内建事件（事件面板展示）
        "children": []
      }
    ]
  }
}
```

## 4. 变更流程

1. Arch-Agent 在 `docs/v2/adr/` 新增 ADR（编号递增），写明变更点、受影响字段与兼容 / 迁移方案，知会 PM-Agent。
2. PM-Agent 广播到受影响的在途卡（T0.2 模板脚手架、T1.1 schema、T1.6 运行窗口等）。
3. 修改 `src/ir/types.ts`；若文件格式版本变化，`ProjectFile` / `UIAsset` 的版本字段与读取路径的兼容策略一并写入该 ADR。
4. 禁止绕过 ADR 直接修改本契约。

**遗留 / 预留（后续 ADR 扩展）**：

- `anchors` 骨架 → T1.1 细化锚点语义后修订本 ADR 并替换类型。
- UI 预制体引用字段（T7.3）、`.history` 快照格式（T7.4）→ 各自任务落地时扩展。
- `engineVersion` 的具体兼容规则（如 semver 比较行为）由 T0.2 模板脚手架给出默认值约定，格式本身不受影响。
