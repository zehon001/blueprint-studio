# ADR-017：引用完整性校验与改名级联（T13.1）

> 2026-10-18 · 状态：已采纳

## 决策

1. **校验入口**
   - UI/元素资产在打开、保存、命令栈变更（300ms 防抖）时执行 `validateOpenUIAsset`；
   - 校验输入 = 资产树 + 内嵌图 + 已应用样式表类集合 + 项目元素/样式/预制体清单 +
     项目/全局函数名 + 内置库清单（elements/styles/functions）；
   - 内置库服务不可用时不误报 `ref-library-missing`，改报 warning
     `library-manifest-unavailable`；
   - 设计模式底部校验条与蓝图模式共用 `ValidationBar`；错误阻止保存。

2. **错误码覆盖**
   - `ref-node-missing`：`ui.get.target`、`ui.getProp/setProp.nodeName`、所有 UI 访问器
     未连线的 `name` 引脚（已连线时由运行时解析，不做静态误报）；
   - `ref-variable-missing`：全部内嵌图的 `var.get/set.varName`；
   - `ref-function-missing`：`flow.call` 的 `scope=blueprint/project/global` 显式查找，
     `auto` 按蓝图 → 项目 → 全局就近解析；离线时跳过项目/全球段；
   - `ref-style-missing`：节点 `classes` 不在已应用样式表中，或项目样式表文件不存在；
   - `ref-library-missing`：`@library/*` 条目不在库清单；
   - `ref-element-boundary`：项目元素/预制体不存在；内置库资产引用项目元素/样式/预制体。

3. **点击跳转**
   - 带 `graphName + nodeId` 的问题 → 切到蓝图模式、打开对应图并选中节点；
   - 仅 `nodeId` → 设计模式选中该节点；
   - 跨文件问题（样式/库条目）只展示消息，不伪造定位。

4. **改名级联**
   - 变量/事件：blueprint store 命令内级联（可撤销）；
   - 资产内函数：`renameFunction` 级联 graphs 键、entry/layout、`flow.call.graph` 与
     `function+scope=blueprint/auto`；
   - 项目/全局函数、元素文件、样式文件：编辑器改名动作扫描当前项目 JSON 资产并改写引用
     （`cascadeFunctionRename` / `cascadeElementRename` / `cascadeStyleRename`）；
   - 样式类改名：样式表编辑器改键 + `cascadeRenameStyleClass` 更新项目 UI/元素资产。

## 后果

- 外部手工改文件造成的孤儿引用会在下一次打开/保存/编辑时显示；
- 改名级联依赖当前打开项目；跨项目引用不在 v3 范围内（库条目跨机由导出/导入兜底）。
