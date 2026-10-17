# tests/e2e —— TA.2 E2E 冒烟（PLAN §20.3 场景脚本化）

本地服务 **API 链路**的可重复冒烟：`node:test + tsx` 直连 `http://localhost:8790`，不启 vite、不开浏览器（浏览器层冒烟由 PM 实机走查覆盖，见 TASKBOARD B11/B12 回归记录）。

## 跑法

```bash
# 前置：本地服务已在跑（默认端口 8790）
npm run server

# 另开终端：跑 E2E 冒烟
npm run e2e
```

- **无服务环境 / CI 不红**：脚本开头先探测 `GET /api/health`，不可达时**全部场景 skip** 并提示「启动 npm run server 后重跑」。
- 可用环境变量 `BP_E2E_BASE` 覆盖服务地址（默认 `http://localhost:8790`）；也可用于在无服务环境下人工验证 skip 路径，例如 `BP_E2E_BASE=http://localhost:9 npm run e2e` → 应 6 skipped 0 failed。
- 本命令**不并入**全量基线命令（`npx tsx --test "src/**/*.test.ts" ...` 保持 830 绿），测试文件独立放在 `tests/e2e/`、由独立 npm script 执行。

## 前置

- Node ≥ 22（`node:test` + 全局 `fetch`）；仓库自带 devDependencies，**无新增依赖**。
- `npm run server`（`tsx watch server/index.ts`，端口 8790）。
- 项目安全根默认 `<repo>/_projects/`（可用 `BP_PROJECTS_ROOT` 覆盖）；测试只创建 / 删除以 `e2e-smoke-` 开头的自建项目目录，不碰其他项目。

## 场景清单（`smoke.e2e.test.ts`，每场景独立项目名 `e2e-smoke-<时间戳>-<场景>`，结束统一清理）

| # | 场景 | 对应 §20-3 环节 | 关键断言 |
|---|------|----------------|----------|
| ① | 新建项目（log-analyzer 模板） | 新建项目 | 201 + 项目列表在列；目录树含模板资产（ui/logic/assets/plugins + project.json + main.ui.json + main.bp.json + sample.log）且 `.history` 隐藏；project.json 模板变量已替换（name/mainUI/engineVersion） |
| ② | 写 UI 资产 | 拼日志查看 UI | `PUT /api/file` 写 main.ui.json（vbox+label+list）→ 读回逐字节一致；新子路径写入自动建父目录 |
| ③ | 写蓝图资产（forLoop 0..2 + print 循环体） | 蓝图连线 + 运行观察 | `PUT /api/file` 写读一致；`deserializeIR/serializeIR` JSON 往返无损；`validateIR` 无 error；**进程内 createRuntime 执行**：forLoop 一次触发跑完 0..2，print 输出 `0,1,2`（ADR-008 语义，无需循环体回连） |
| ④ | TS 转译诊断 | 脚本链路 | 合法脚本 → `ok:true` + js 产物；语法错误 → 200 + `ok:false` + `errors[{line,column,message}]`（行列 1 起） |
| ⑤ | 插件注册表 | 插件清单 | `GET /api/plugins` 内置清单 `phone-log` / `feishu-cli` 在列 |
| ⑥ | 保存前快照 | 保存快照 | **依赖 T7.4**：`/api/history` 未落地（服务端 404）时 skip 并注明；已落地则校验 200 + 服务端统一 `ok:true` 约定（细粒度契约随 T7.4 深化） |

## 已知边界

- 场景③的「运行观察」采用进程内解释器（`createRuntime`，节点库经 `builtinSpecMap` 注入）验证 ADR-008 语义；运行窗口→WS 调试观察（debug.v1）的端到端链路由 T5.4 服务端单测 + PM 实机走查覆盖，不在本卡范围。
- 服务端无「删除项目」API，清理通过 `/api/health` 返回的 `projectsRoot` 直接删除自建目录（`fs.rmSync recursive`）。
