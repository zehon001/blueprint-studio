# ADR-016：资源库存储与服务端（T11.4）

> 2026-10-18 · 状态：已采纳

- 库根：`%USERPROFILE%\.blueprint-studio\library`，`BP_LIBRARY_ROOT` 可覆盖；独立安全根，校验存在/可写/不与 `_projects` 重叠（越界 403）。
- 布局：`elements/*.elem.json`、`styles/*.uss.json`、`functions/*.fn.json`；`.history/` 保存前快照。
- REST：`/api/library/{list,read,write,delete,rename,history,restore,export,import,watch}`；`{ok:true,...}` 契约，错误走 `FsError` 统一中文映射。
- 导出：无第三方依赖的最小 zip（store 模式 + CRC32），含 `manifest.json`（sha256 指纹清单）；导入：skip/overwrite/rename 三策略 + 指纹校验 + 越权/跨类型拒绝。
- watch：SSE 广播 `{kind,name,action}`（saved/deleted/renamed）；写/删/改名/恢复触发。
- 测试：`server/library.test.ts` 40 项（CRUD/路径越界/重叠/history/zip 往返/冲突/指纹/SSE/@library 引用收集）。
