# ADR-004：插件清单与注册表

| 状态 | 日期 | 关联卡 | 影响范围 |
|---|---|---|---|
| 已接受 | 2026-10-17 | T0.1 | `plugins-registry/`（T6.1 / T6.5 / T6.6）、`server/plugins/`（T6.1 / T6.3）、`src/nodes/dynamic.ts`（T6.4）、`src/panels/plugin-manager/`（T6.2） |

## 1. 决策内容

- 插件分两类（`PluginManifest.kind`）：
  - **`cli`**：封装已存在的外部 CLI（adb、飞书 CLI 等），**不实现功能本体**——只做「检测是否已安装 → 安装命令 → 更新检测」+ 节点封装；安装命令清单化，可在设置中被覆盖（跨平台差异兜底）。
  - **`custom`**：自定义插件，项目 `plugins/` 或服务端静态目录挂载；manifest 同构 + 可选服务端执行器（`executor.cjs`，入参 / 出参 JSON），服务端负责静态托管与调用入口（执行器协议由 T6.1 / Server 落地，不在本 ADR 范围）。
- **三源注册表**：内置 `plugins-registry/`（随引擎分发）+ 项目 `plugins/` + 服务端静态目录，三者**合并去重**（`mergeManifests`，键 = 插件 id）；`source` 字段由注册表按发现位置标注后附加，不在清单 JSON 中手写。
- 插件节点经 `src/nodes/dynamic.ts` 注册后与内置节点完全同权（同一 NodeSpec 结构，同样有 exec / 数据引脚）。
- 版本判定（PLAN §14.2）：`detect.cmd` 的输出按 `detect.versionRegex` 提取当前版本，与 `update.latestVersion` 比较 → `已安装·最新`（更新按钮置灰）/ `可更新`；detect 执行失败 = `未安装`。无 `detect` 的清单（自定义插件）状态为 `自定义`。

对 PLAN §14.1 示意的**规范化**（本契约为准）：

1. `PinSpec.type` 必填，exec 引脚显式写 `"type": "exec"`（示意中省略的写法无效）；
2. select 型引脚写作 `"type": "string"` + `options: { value, label }[]`（`"select"` 不是值类型，见 ADR-003 规范化第 2 条）；
3. 持续流事件节点显式声明 `kind: "event"`，无 exec 入口、有 exec 出口。

## 2. 结构定义

类型真源：[src/ir/types.ts](../../../src/ir/types.ts)。

| 类型 | 用途 |
|---|---|
| `PluginManifest` | 插件清单：id / name / kind / description / detect? / install? / update? / nodes / source? |
| `DetectSpec` | 检测命令：cmd / versionRegex?（检测失败 = 未安装） |
| `InstallSpec` | 安装命令：strategy（winget / npm-global / download-zip / custom-cmd）/ args? / cmd? |
| `UpdateSpec` | 更新信息：latestVersion / source |
| `PluginNodeSpec` | 插件节点 = NodeSpec 同构 + `kind?: 'action' \| 'event'`；id 必须带插件 id 前缀 |
| `PluginRegistryEntry` | 注册表条目（= `PluginManifest` 的类型别名） |
| `mergeManifests(lists)` | 三源合并去重（传入顺序 = 优先级：内置 → 项目 → 静态目录；当前实现先到先得） |

## 3. 示例

```jsonc
// plugins-registry/phone-log.json（基于 PLAN §14.1 示例规范化）
{
  "id": "phone-log",
  "name": "手机日志",
  "kind": "cli",
  "description": "adb 读取手机日志 / 解析 Android 日志文件",
  "detect": { "cmd": "adb version", "versionRegex": "Android Debug Bridge version ([\\d.]+)" },
  "install": { "strategy": "winget", "args": ["Google.PlatformTools"] },
  "update": { "latestVersion": "35.0", "source": "registry" },
  "nodes": [
    {
      "id": "phoneLog.read",               // 插件节点 id = 插件前缀 + 节点名
      "title": "读取手机日志",
      "category": "插件",
      "inputs": [
        { "id": "exec", "type": "exec" },
        { "id": "mode", "type": "string", "label": "读取模式", "defaultValue": "file",
          "options": [ { "value": "device", "label": "手机读取" }, { "value": "file", "label": "文件读取" } ] },
        { "id": "packageFilter", "type": "string", "optional": true },
        { "id": "files", "type": "file[]", "optional": true, "multi": true }   // file = 自定义对象类型别名
      ],
      "outputs": [
        { "id": "exec", "type": "exec" },
        { "id": "rows",  "type": "LogRow[]" },
        { "id": "count", "type": "int" }
      ]
    },
    {
      "id": "phoneLog.onLine",             // 持续流模式：logcat 不加 -d，行推送走 WS
      "title": "手机日志·新行",
      "category": "插件",
      "kind": "event",                     // 推送驱动：无 exec 入口，有 exec 出口
      "inputs": [],
      "outputs": [
        { "id": "exec", "type": "exec" },
        { "id": "line", "type": "string" }
      ]
    }
  ]
}
```

注册表合并（T6.1 按此调用）：

```ts
import { mergeManifests } from '../src/ir/types';

// lists 顺序 = 优先级：同名清单高优先级源胜出；返回新数组
const registry = mergeManifests([builtinManifests, projectManifests, staticDirManifests]);
```

## 4. 变更流程

- **新增插件 / 清单内容调整（不改格式）不需要 ADR**：直接增改 `plugins-registry/*.json`，由对应任务卡（T6.5 / T6.6）验收。
- 以下情况属于契约级变更，必须走 ADR：`PluginManifest` 及其子结构字段增删或语义修改、`InstallStrategy` 枚举扩展、合并去重语义变更。
- 流程同 ADR-001 §4：Arch-Agent 落 ADR → PM 知会 → 修改 `src/ir/types.ts` → 受影响卡（注册表 / 执行器 / 管理界面 / dynamic 注册）跟进。

**遗留 / 预留（后续 ADR 或任务卡定案）**：

- 合并去重的优先级语义当前为「先到先得（内置 > 项目 > 静态目录）」，正式定案在 T6.1。
- 自定义插件的 `executor.cjs` 入参 / 出参 JSON 协议由 Server-Agent（T6.1 / T6.3）定义，定案后可回写本 ADR。
- `update.source` 当前仅作展示与人工核对；是否接入自动检查更新的远程源，M6 明确排除（不做插件市场 / 远程注册表）。


## 追认记录（T6.1/T6.5 定案，PM 2026-10-17）

1. **三源合并优先级**：项目 > 静态目录 > 内置（同 id 整清单覆盖）。
2. **插件节点 id 前缀**：`camelCase(pluginId) + '.'`（如 `phone-log` → `phoneLog.read`）；兼容字面 `${pluginId}.` 读取；插件 id 约束 `^[A-Za-z][A-Za-z0-9_-]*$`。`pluginNodePrefix` 当前在 server/plugins/registry.ts 与 src/nodes/dynamic.ts 各一份（逻辑一致，测试锁定），后续可上移 src/ir/types.ts 单源化。
3. **清单可选字段 `invoke?: { cmdTemplate: string }`**（T6.6）：CLI 插件节点的透传调用命令模板（如 `"feishu send --text {message}"`）；`{message}` 必填占位；target 非空时若模板含 `{target}` 直接替换，否则在首个 `--text` 前插入 `--to "<target>"`。validateManifest 已校验（非对象/空 cmdTemplate 报中文错）。
