# tests/roundtrip —— roundtrip 幂等测试框架（TA.1）

Blueprint Studio v2 的 **roundtrip 正式门禁**：`IR → codegen(TS) → parse → IR'` 必须幂等
（PLAN §10「一致性保障」/ §20-2「总验收 2：roundtrip 幂等测试全绿」），并以此保障
DoD「**新节点必须补样例入库**」——任何新增 builtinSpecs 节点若不补样本、也不登记
「已知无法往返清单」，门禁直接红灯。

## 目录结构

| 文件 | 职责 |
|---|---|
| `roundtrip-helpers.ts` | 共享助手：**纯 re-export** 自基座 `src/script/roundtrip.test.ts`（roundtripIR / canonicalIR / firstDiff 比较器、asset/node/graph/execEdge/dataEdge/pureNodeSample 样本构造器、五个场景样本、断言助手）。不复制实现，比较规则单源。 |
| `samples.ts` | 样本注册表 `roundtripSamples`（数组 `{ name, kind, build(): IRAsset }`）+「已知无法往返清单」`KNOWN_UNMAPPED_NODE_IDS` + 覆盖审计 `auditCoverage`。 |
| `roundtrip.test.ts` | 正式门禁测试（门禁 ① 全节点 / ①b 计数守卫 / ② 真实资产 / ③ 场景 + 片段 / ④ 幂等二次验证）。 |
| `README.md` | 本文件。 |

## 运行方式

```bash
npm run roundtrip          # tsx --test tests/roundtrip/*.test.ts
```

- git bash / POSIX shell 下通配符可用；若 shell 不展开 glob（如 PowerShell），请写全文件名：
  `npx tsx --test tests/roundtrip/roundtrip.test.ts`。
- 因 helpers re-export 自基座测试文件，运行本目录时基座的 18 个测试同进程注册执行
  （node:test 行为）——它们同时构成比较器自身的持续回归。
- 回归基座与校验器：`npx tsx --test src/script/roundtrip.test.ts src/ir/validate.test.ts`。

## 规范形比较规则（断言口径）

```
normalizeIR(asset) ≡ normalizeIR(parseScriptToIR(codegenTS(asset)).asset)
```

深等比较在**确定性规范化**（`canonicalIR`，基座实现）之后进行：

1. **先过 normalizeIR**（`src/ir/validate.ts`）：洗字段、剔除 undefined 与空的可选容器、
   记录键字典序排序——产出「规范形」，`serializeIR` / `.bp.json` 保存链路同源；
2. **节点 / 连线实例 id**：纯节点内联为表达式后 id 无法在代码文本中无损携带，双侧按
   「结构精化键（WL 迭代，至多 12 轮或稳定）+ 稳定排序」重命名为 `n1..nK` / `e1..eK`
   （同键按原 id 决胜，保证对称结构两侧结果一致）；
3. **position / layout**：编辑状态，codegen 不保留，双侧清零剔除；`title` / `comment`
   为显示覆盖（蓝图视图域），同样不参与比较；
4. **events / snippets 数组序**：事件表 / 片段表在往返中按「方法序 + 孤儿序」重建，
   按名 / id 排序后比较（variables 顺序可无损往返，不排序）；
5. **等于 spec 默认值的显式引脚值**：一次往返后归一化为缺省（语义不变）——因此样本
   约定不显式写入「等于 spec 默认值」的引脚值；
6. **幂等二次验证**：对 roundtrip 的输出再跑一轮 codegen→parse，仍与首轮输出等价
   （`roundtripIR` 内置；门禁 ④ 对全部样本独立复核）。

单样本断言三件套：roundtrip 全绿 + 解析零诊断 + 生成码经 esbuild 转译无错。

## 样本注册表（samples.ts）

`roundtripSamples` 四类（`kind`）：

- **node**（69 条）：builtinSpecs 逐节点样本——52 个纯节点经共享构造器 `pureNodeSample`
  自动生成（引脚取 spec 默认值 / 字面量，结果交给 system.print）；17 个可往返执行节点
  在 `execNodeSampleDefs` 显式登记最小图（event.start/custom/send/listen、flow.branch/
  forLoop/whileLoop/delay、array.forEach、var.set、ui.get/setValue/setVisible/
  listSetItems、system.print）。
- **scenario**（4 条）：业务场景样本，复用基座样本库（单源）：全特性手工样本（含片段、
  事件、函数图、双循环）、条件循环计数、日志分析管线、字符串处理链。
- **snippet**（1 条）：T3.7 多片段引脚重建专项（exec 片段引脚连线 / 纯片段前奏 /
  链尾 / 孤儿多引脚，ADR-007）。
- **asset**（2 条）：真实资产样本——读取 `templates/log-analyzer/logic/main.bp.json`
  （deserializeIR）直接 roundtrip；及其「片段演化」变体（模拟编辑器插入片段节点后再
  roundtrip）。另验证 `.bp.json` 序列化幂等（`serializeIR ∘ deserializeIR` 恒等）。

## 新节点入库流程（两步）与门禁机制

**新增 builtinSpecs 节点时：**

- **步骤一 · 样本构造进 `samples.ts`**：
  - 纯节点（`pure: true`）：无需动作——`pureNodeSample(specId)` 自动覆盖；
  - 执行节点：在 `execNodeSampleDefs` 加一条 `{ id, build, note }` 最小图构造器
    （事件入口/链头 + 该节点 + system.print，按 codegen 映射形态接线）。
- **步骤二 · 「已知无法往返清单」维护（`KNOWN_UNMAPPED_NODE_IDS`）**：
  仅当该执行节点当前**无法往返**时登记，并注明原因。清单分两类：
  1. *暂无脚本映射*（codegen 抛「暂无脚本映射」）：`flow.gate` / `flow.flipFlop` /
     `flow.doOnce` / `flow.multiGate` / `event.timer`（状态机类，无线性语句形态）、
     `system.notify` / `system.clipboardWrite` / `system.openUrl`（解释器钩子类）；
  2. *往返缺口*：曾发现 `flow.sequence`（parser 标记扫描正则不匹配）与
     `ui.setTitle`（attr 反查缺 title 映射）两项，**已于 2026-10-17 修复并移出
     清单**（样本见 execFlowSequence / execUiSetTitle）；如再发现同类缺口，
     修复 parser 后应从清单移除并补样本（构造提示见 samples.ts 内注释）。

**门禁机制（防新节点静默漏测）：**

- 硬门禁 = 计数恒等式：`builtinSpecs 总数 = 已测数 + 已知跳过数`（`auditCoverage` 纯函数）。
  新增节点不补样本、也不进清单 → 计入 `missing` → 门禁 ① 红；
- 清单卫生：节点从 builtinSpecs 删除后清单残留 → 计入 `stale` → 门禁 ① 红；
- 「计数守卫」用例（门禁 ①b）直接断言该机制本身，无需真改文件：
  ① 模拟从清单删一项 → 审计恰报 1 个 missing、恒等式打破（红）；
  ② 假想新增执行节点 `{ id: 'flow.ghostNode' }` → missing 包含它（红）；
  ③ 该节点登记进清单副本 → missing 清空、恒等式恢复（绿）。

即：**门禁红 = 有人加了节点但没走入库流程**；处理方式只有两条——补样本（可往返）或
登记清单（确认暂无法往返），不存在第三条静默路径。

## 与 ADR 的关系

- **ADR-004（插件清单与注册表）**：插件节点经 `src/nodes/dynamic.ts` 运行时注册，
  **不进入 `builtinSpecs`**，故不在本门禁的计数范围内；插件节点与内置节点同权后若要
  纳入 roundtrip 门禁，应扩展 `auditCoverage` 的 specs 入参（清单合并后传入）并按
  `bps.<节点id>(...)` 兜底形态构造样本。内置清单（如 phone-log）节点样本可参考
  `src/nodes/dynamic.test.ts` 的真实清单读取方式。
- **ADR-007（脚本片段引脚契约）**：片段节点（script.snippet）的往返由
  `IRSnippet.pins` 元数据承载——`__bps-snippet-begin` 标记行携带 `{ lang, pins }`，
  数据入/出脚经 `__bps-snippet-in/out` 别名行重建，孤儿片段经 `__bps-loose-*` 恢复，
  不可映射语句折叠的引脚推导进标记元数据保持幂等。本框架的 snippet 专项样本
  （基座样本⑩）与全特性样本（含 snip1）即该契约的回归载体；折叠推导幂等见基座 ⑪⑫。

## 维护约定

- 比较规则（canonicalIR / roundtripIR / firstDiff）**只改基座**
  `src/script/roundtrip.test.ts`——本目录 re-export 单源，不复制实现；
- 样本构造：执行节点只加 `execNodeSampleDefs` 条目；场景样本优先复用基座（export 单源）；
- 门禁红灯时的排查顺序：`missing`（新节点未入库）→ `stale`（清单陈旧）→
  具体样本的 `首差异` 输出（比较器给出精确 JSON 路径）。
