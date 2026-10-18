# ADR-015：函数三档作用域（T12.1）

> 2026-10-18 · 状态：已采纳（运行时解析落地，编辑器最小版）

- 三档：蓝图函数（资产 `graphs` 子图）/ 全项目函数（项目 `library/functions/<name>.fn.json`）/ 全局函数（内置库 `@library/functions/<name>`）。
- `flow.call` params：`graph`（资产内目标，兼容 v2）、`function`（跨作用域函数名）、`scope: auto|blueprint|project|global`（缺省 auto）。
- 解析顺序：资产图 → 项目库 → 内置库；显式 scope 不回落，缺失记 `ref-function-missing`（T13.1）。
- 运行时：`src/runtime/functions.ts` 在 `BindingRunner` 建 runtime 前加载外部函数，注入唯一图名 `__fn_<scope>_<name>` 并改写调用节点 `params.graph`；入参/返回值沿用 `.fn.json` 的 `params/returns`。入参资产不被修改。
- 蓝图侧：资产内函数图进入右键搜索「函数」分组，选中即建 `flow.call` 并预填 `graph`；项目/全局函数的检索与函数编辑器 UI 为后续增强。
- 函数资产：`{ version:3, kind:'function', scope, name, params, returns, graph }`；布尔/执行边界随 T13.1。
