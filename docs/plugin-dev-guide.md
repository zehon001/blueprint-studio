# Blueprint Studio v2 · 插件开发指南

> 面向插件作者：如何为外部 CLI / 自定义能力编写插件清单，让节点出现在蓝图里。
> 契约真源：`src/ir/types.ts`（PluginManifest / PluginNodeSpec）· ADR-004（含 T6.1/T6.6 追认记录）。
> 实现参照：`server/plugins/registry.ts`（校验 / 三源合并）、`server/plugins/executor.ts`（detect / install / invoke / 持续流）、`src/nodes/dynamic.ts`（动态注册）。
> 基准版本：2026-10-17。三份内置清单 `plugins-registry/phone-log.json`、`plugins-registry/feishu-cli.json` 是权威范例。

---

## 1. 插件模型

| 种类（`kind`） | 定位 |
|---|---|
| `cli` | 封装**已存在**的外部 CLI（adb、feishu）：引擎不实现功能本体，只做「检测是否安装 → 安装命令 → 更新检测」+ 节点封装；调用 = 服务端按命令模板构造并**透传执行** |
| `custom` | 自定义插件：项目 `plugins/` 或服务端静态目录挂载；清单同构；调用走 invoke 通道（`args.__cmd` 透传 / 未来执行器） |

- 插件节点经 `src/nodes/dynamic.ts` 注册后与内置节点**完全同权**（同样的 exec / 数据引脚），但不进 `builtinSpecs`（不参与内置 roundtrip 门禁）。
- 明确不做：插件市场 / 远程注册表；`update.source` 仅作展示。

## 2. 清单 schema（PluginManifest）

一个插件 = 一个 JSON 文件（顶层 `*.json`，目录内不递归）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✔ | 全局唯一；约束 `^[A-Za-z][A-Za-z0-9_-]*$`（字母开头；作为节点 id 前缀使用） |
| `name` | ✔ | 显示名（中文可） |
| `kind` | ✔ | `'cli'` 或 `'custom'` |
| `description` |  | 管理界面列表显示（缺省补空串） |
| `detect?` |  | `{ cmd, versionRegex? }`：检测命令 + 版本提取正则（第一捕获组）。**省略 = 不检测**，状态恒为「自定义」 |
| `install?` |  | `{ strategy, args?, cmd? }`，见 §5；省略 = 管理界面只提示手动安装 |
| `update?` |  | `{ latestVersion, source }`；省略 = 不参与版本判定（状态恒「已安装」） |
| `invoke?` |  | `{ cmdTemplate }`：CLI 透传命令模板（§7，T6.6 扩展字段） |
| `nodes` | ✔ | 插件节点数组（可为空 = 纯检测/安装型挂载） |
| `source` | — | **不要手写**：由注册表按发现位置标注（`builtin` / `project` / `static`），手写会被覆盖 |

`validateManifest` 校验规则（不通过 → 该清单被跳过并记入警告，不炸注册表；中文错误信息）：

- `detect.versionRegex` 必须可编译；`install.strategy` ∈ 四策略；`custom-cmd` 必须带非空 `install.cmd`；`update.latestVersion` / `update.source` / `invoke.cmdTemplate` 非空字符串。
- 每个节点：`id` 必须带插件前缀（§4）、`title` 非空、`inputs` / `outputs` 必为数组、每个引脚有非空 `id` 与 `type`（**exec 引脚显式写 `"type": "exec"`**；`options` 出现时须为 `{value, label}` 数组）。
- `kind: "event"` 的持续流节点：**不允许 exec 输入引脚、必须有 exec 输出引脚**。
- 节点 `kind` 省略 = `'action'`。

## 3. 三源注册表与合并优先级

| 源 | 位置 | 说明 |
|---|---|---|
| 内置 | `<仓库>/plugins-registry/*.json` | 随引擎分发 |
| 项目 | `<项目>/plugins/*.json` | 项目级自定义插件 |
| 静态目录 | `<仓库>/_plugins-static/*.json` | 服务端托管挂载 |

**合并优先级（T6.1 定案）：项目 > 静态目录 > 内置**——同 id 插件**整清单覆盖**（`mergeManifests` 先到先得，服务端按优先级从高到低传入）。加载路径：`GET /api/plugins?project=<项目>` 返回 `{ ok, manifests, warnings }`；单文件损坏 / 校验失败记入 `warnings`（管理界面顶部警告条 + 运行窗口控制台），其余清单不受影响。

## 4. 节点前缀规则（camelCase）

- 插件节点 id 必须 = **`camelCase(插件id) + '.' + 尾段`**：`phone-log` → `phoneLog.read`；`feishu-cli` → `feishuCli.send`。兼容字面 `${pluginId}.` 写法（`phone-log.read` 会被归一为 `phoneLog.read`）。
- 运行时注册（`pluginSpecsFromManifest`）还会：title 加来源角标（如「读取手机日志（插件·内置）」）、`category` 恒改为 `'插件'`（紫头 / 搜索同组）、keywords 自动补插件名 / id / 尾段、doc 追加来源说明。
- **插件 id 起名建议**：短 kebab-case（如 `rds-report`）；节点 id 用 camelCase 前缀书写（清单里就写 `rdsReport.query`）。

### 4.1 清单引脚 → 运行时 PinSpec 的规范化映射

| 清单写法 | 注册后 | 说明 |
|---|---|---|
| `"type": "exec"` | 原样 | 必须显式 |
| `"type": "select"` + `options` | `type: "string"` + options | `select` 不是类型；options 字符串项会规范化为 `{value,label}` |
| `"type": "number"` | `type: "float"` | 不用 `number` |
| `"type": "file"` | `type: "string"`（label 补「文件」语义） | 文件路径字符串 |
| `"type": "file[]"` | `type: "string[]"`（label 补「文件」语义） | 多选文件路径数组 |
| 其余（含 `LogRow[]` 等别名） | 原样 | 自定义别名解释器不展开 |

`params` / `doc` / `keywords` 透传；`pure` 恒为 `false`（插件节点都是执行节点）。

## 5. 安装策略（install）

服务端 `buildInstallCommand` 按策略构造命令（设置中的 `cmdOverride` 可整体覆盖，跨策略生效）：

| strategy | args[0] 生成的命令 | 备注 |
|---|---|---|
| `winget` | `winget install -e --id <包id> --accept-source-agreements --accept-package-agreements`（update 用 `winget upgrade …`） | 如 `Google.PlatformTools` |
| `npm-global` | `npm install -g <包名>`（update 追加 `@latest`） | |
| `download-zip` | **占位策略**：不自动下载，返回手动步骤说明（下载 args 中的地址 → 解压 → 加入 PATH → 重新检测） | |
| `custom-cmd` | 原样执行 `install.cmd`（install / update 共用） | |

执行细节：同插件 id **并发锁**（同一时间只允许一个安装/更新任务）；stdout/stderr 合并逐行 SSE 回传（`data:{"type":"log"|"done"|"error",…}`，15s 心跳）；输出超 1MB 截断；客户端取消 → 杀进程树；退出码 0 → `done` 事件附自动重 detect 结果（管理界面据此刷新徽标）。

## 6. 检测与版本判定（detect）

- `detect.cmd` 执行（10s 超时、256KB 输出上限）→ `versionRegex` 第一捕获组提取当前版本 → 与 `update.latestVersion` **semver 逐段比较**（数字段按数值、非数字段按字典序、段数不齐补 `'0'`；任一侧解析失败 = 不可比 = 不可更新）。
- **detect 执行失败（非零退出 / 超时）= 未安装**；「命令不存在」按退出码 9009/127 与报文特征双重判定。
- 管理界面状态徽标：`未安装`（【安装】）/ `已安装·最新`（更新按钮置灰）/ `可更新`（当前版 → 最新版，【更新】）/ `自定义`（无 detect，【重载】）。
- 检测命令可在设置中覆盖（`cmdOverride`，base64url 传输）。

## 7. invoke：节点调用的服务端通道

蓝图节点（或脚本侧节点路径）运行时 → `POST /api/plugins/invoke`，body `{ plugin, node, args, project? }`（`args` = 未连线省略后的输入引脚值；exec 引脚剔除）。响应 `{ ok, outputs?, stdout?, stderr?, message?, streamId? }`。

`handleInvoke` 的路由顺序：

1. **插件专属执行器**：`phone-log`（`phoneLog.read` 双模式 + `phoneLog.onLine` 持续流，见 §8）；`feishu-cli` 的 `feishuCli.send`（命令模板透传）。
2. **通用透传通道**：`args.__cmd`（命令字符串）→ shell 执行（30s 超时，返回 stdout 尾部 100KB）——对任意插件 id 开放的逃生通道。
3. 其余：已注册插件 → `ok:false`「未实现执行器」；未注册 → 404。

**客户端侧降级纪律（`invokePluginNode`）**：`ok:false` / 网络失败 / abort → 控制台打印中文原因（stderr 一并透传）→ 按声明输出引脚给**默认值**（`string`→`''`、数值→0、`bool`→false、数组→`[]`、其余→null）→ exec 出脚恒给出——**蓝图可跑不崩**。stdout 非空时自动打印到控制台。

### 7.1 cmdTemplate 透传封装（cli 插件推荐形态）

清单声明 `invoke: { cmdTemplate }` 后，节点参数即可由服务端按模板构造命令：

- 占位符：`{message}`（必填）、`{target}`（可选）。
- `target` 非空且模板未含 `{target}` 时，按内置约定在首个 `--text` 前插入 `--to "<target>" `；无 `--text` 标记则追加尾部。
- 值引用：引号包裹 + 去内部双引号 + 换行折空格（cmd.exe 尽力而为；跨平台加固需走 ADR）。

范例（`feishu-cli.json`）：模板 `feishu send --text {message}`，节点 `feishuCli.send`（输入 `message` 必填 / `target` 可选，输出 `text` = stdout 尾部）。服务端执行 → `outputs.text` 承载 CLI 输出，`ok = (退出码 == 0)`。

## 8. 事件型插件节点（持续流）

持续流 = **无 exec 入、有 exec 出** 的节点（清单 `kind: "event"`），由服务端推送驱动，每条推送触发一次出脚（无需 exec 链触发）：

```jsonc
{
  "id": "phoneLog.onLine", "title": "手机日志·新行", "kind": "event",
  "inputs": [],
  "outputs": [ { "id": "exec", "type": "exec" }, { "id": "line", "type": "string", "label": "日志行" } ]
}
```

运行链路（当前实现，phone-log 为范例）：

1. 运行窗口发现资产使用了 event 型插件节点（按形状识别：无 exec 入 + 有 exec 出）→ 自动经 WS 订阅：客户端发 `{ type:'plugin.subscribe', project }`。
2. **启动 / 停止流 = 服务端 invoke**：`phoneLog.onLine` 的 args `{ action:'start', serial?, packageFilter? }` → spawn `adb … logcat -v time`（不加 `-d`）长进程，返回 `streamId`；`{ action:'stop', streamId }` → 杀进程树。**现状注记**：该调用需直达 invoke 通道（服务端 / 脚本桥）；蓝图内 event 节点无 exec 入口、其 run 尚未接「放图即自动启动」的接线，启动流目前要靠脚本片段内 `fetch('/api/plugins/invoke', …)` 直调或等待后续版本统一。
3. 每产生一行 → 服务端广播 `{ type:'plugin.push', plugin, streamId, line, project }` → 运行窗口转成事件总线投递：**事件名 `'line'`，参数 `{ line, streamId }`**（target 本 UI 实例组）→ 蓝图用 `监听事件`（eventName=`line`）或脚本 `@onEvent('line')` 消费；流结束广播 `plugin.close` → 总线事件 `'close'`（参数 `{ streamId }`）。
4. 项目最后一名订阅者离开（连接断开 / 退订）后 5s（抗瞬断）自动停掉该项目名下的流；单流输出上限 4MB；启动后 250ms 内退出 = 启动失败（`ok:false`，典型：adb 不存在）。

## 9. 调试与日志

| 场景 | 去哪看 |
|---|---|
| 清单损坏 / 校验失败 | 管理界面顶部警告条 + `GET /api/plugins` 的 `warnings` + 运行窗口控制台 `[插件] …` |
| 安装 / 更新过程 | 管理界面内嵌日志区（SSE 实时、可暂停 / 取消、error 行红色） |
| 节点调用失败 | 运行窗口控制台 / 编辑器控制台：`[插件] <节点id> 调用失败：<message>（已按默认输出继续执行）`，stderr 随行透传 |
| 节点调用成功（stdout 非空） | 控制台：`[插件] <节点id> 输出：…` |
| 持续流 | 控制台看启动消息；行数据直接驱动蓝图（`监听事件 'line'`） |

排障建议：先在管理界面点行展开确认节点引脚声明与连线一致 → 看 detect 状态与实际命令（确认框 / detect 响应的 `cmd` 字段）→ 失败行看 `message` / `stderr`（Windows 中文环境注意 GBK 乱码可能）。

### 9.1 服务端端点速查（插件作者调试用）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/plugins?project=<项目>` | GET | 三源合并后的清单列表 + warnings |
| `/api/plugins/:id?project=<项目>` | GET | 单个清单（404 = 插件不存在） |
| `/api/plugins/:id/detect?project=&cmdOverride=<base64url>` | GET/POST | 检测：`{ ok, installed, version?, latest?, updatable, cmd }`；detect 失败也返回 `ok:true, installed:false` |
| `/api/plugins/:id/install?project=&action=install\|update&cmdOverride=` | GET（SSE） | 安装 / 更新流：`log` / `done`（附重 detect 结果）/ `error` 事件，15s 心跳 |
| `/api/plugins/invoke` | POST | body `{ plugin, node, args, project? }` → `{ ok, outputs?, stdout?, stderr?, message?, streamId? }`；`args.__cmd` = 通用透传 |
| `/ws` | WS | 调试观察与插件推送共用通道：`plugin.subscribe` / `plugin.unsubscribe` / `plugin.push` / `plugin.close` |

## 10. 自定义插件上手指引

项目根建 `plugins/my-tools.json`：

```jsonc
{
  "id": "my-tools",
  "name": "我的工具",
  "kind": "cli",
  "description": "封装本机 mytool 命令",
  "detect": { "cmd": "mytool --version", "versionRegex": "mytool ([\\d.]+)" },
  "install": { "strategy": "custom-cmd", "cmd": "echo 请手动安装 mytool" },
  "update": { "latestVersion": "1.0.0", "source": "registry" },
  "nodes": [
    {
      "id": "myTools.hello",
      "title": "MyTool·打招呼",
      "category": "插件",
      "keywords": ["mytool", "hello"],
      "doc": "透传执行 mytool hello --name <name>。",
      "inputs": [
        { "id": "exec", "type": "exec" },
        { "id": "name", "type": "string", "label": "名字", "defaultValue": "world" }
      ],
      "outputs": [
        { "id": "exec", "type": "exec" },
        { "id": "text", "type": "string", "label": "输出文本" }
      ]
    }
  ]
}
```

保存后重开插件管理（或点「刷新」）→ 列表出现该插件；蓝图右键搜索「打招呼」即可用。要让 `myTools.hello` 真正出数据，目前用通用通道不合适（它要求 CLI 输出能映射到输出脚——通用通道只回 stdout 文本）；两条路：

1. 给节点声明单个 string 输出脚并配合服务端专属执行器（像 feishu-cli 一样把 stdout 尾部填进 `text`）；
2. 或在清单声明 `invoke.cmdTemplate` 并等待该插件的专属路由（现仅 feishu-cli / phone-log 内置路由）。

无执行器时节点可跑（默认输出 + 中文提示），适合先搭图再接执行器。

## 11. 已知限制与差异注记

- **ADR-004 正文的合并优先级描述**（「内置 > 项目 > 静态」）是遗留文本，**以追认记录为准：项目 > 静态 > 内置**（`server/plugins/registry.ts` 按此顺序传参，实现与测试均锁定后者）。
- **脚本 `plugins.*` 全局与 CLI 桥的衔接缺口**：脚本片段运行环境当前未注入 `callPlugin`，脚本内 `plugins.*` 调用会抛「插件桥未接入」；且能命中服务端执行器的调用形态需插件 id 原文 + 完整节点 id（如 `plugins['phone-log']['phoneLog.read'](…)`）。**当前调插件的可靠方式是蓝图插件节点**；PLAN §9.2 的 `plugins.phoneLog.read({ mode: 'adb', filter })` 写法与本实现不符（参数名应为 `mode:'device'|'file'` / `packageFilter` / `files`）。
- `download-zip` 为占位策略；无远程注册表 / 插件市场；`executor.cjs` 自定义执行器协议尚未落地（custom 插件调用走通用 `__cmd` 通道）。
- Windows 中文环境 CLI 输出 UTF-8 尽力解码 + GBK 兜底，仍可能残留乱码行；`shellQuoteText` 的引用策略为尽力而为（加固需 ADR）。
- 持续流的「清单声明即自动推送」依赖插件专属执行器实现（现仅 phone-log）；且**蓝图内 event 节点尚无「自动启动流」接线**——推送消费可用 `监听事件`（事件名 `line` / `close`），启动流需直达 invoke（见 §8 现状注记）。事件节点在无执行器插件上按一次性拉取降级（控制台提示）。
