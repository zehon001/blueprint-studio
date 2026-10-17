# ADR-007：脚本片段引脚契约（IRSnippet.pins）与不可映射段的往返重建

> 状态：已采纳（2026-10-17）· 发起：Script-Agent（T3.7 单卡执行）· 影响：T3.5 codegen / T3.6 parser / T3.7 片段运行时 / 蓝图视图（T2.1）/ 保存校验器消费方式（T2.8）

## 背景

T3.5/T3.6 建立了片段的最小约定：图中节点 `type = 'script.snippet'`、`params.snippet = IRSnippet.id`，片段源码经 `__bps-snippet-begin/end` 标记对往返，标记行尾携带 `{ lang, pins }` 元数据。但遗留⑤：**片段引脚上的数据连线仅以 wiring 注释可见，不重建**——片段节点在蓝图中只是「黑盒语句」：无引脚渲染、无数据连线、不可在解释器中执行。

T3.7 需要补齐三件事：① 引脚契约定案（本 ADR）；② codegen/parser 的引脚与数据连线完整重建；③ 片段的解释器执行（specs 注入，不改解释器核心）。

## 决策

### 1. IRSnippetPin 契约（定案，types.ts 骨架转正）

```ts
IRSnippetPin = { id: string; dir: 'in' | 'out'; type: IRValueType; label?: string }
IRSnippet.pins: IRSnippetPin[]        // 引脚由作者声明（parser 折叠时给推导初稿）
```

- **exec 引脚约定**：pins 中含 `dir:'in' && type:'exec'` → 片段有 exec 入；含 `dir:'out' && type:'exec'` → 片段有 exec 出。有 exec 入口即执行节点（链上语句）；无 exec 引脚则为**纯片段**（数据引脚求值，`pure` 语义）。
- **引脚 id 必须是合法 JS 标识符**（`isSafeIdentifier`，排除保留字）且**不得与运行时环境全局重名**（print/vars/ui/emit/delay/convert/format/plugins/onEvent）：运行时按名注入函数参数。同 id 的 in/out 对允许（`x = x + 1` 语义：入参 x、代码改写后出参 x）。
- **建议单 exec 出**：codegen 线性化只取第一个 exec 出；多 exec 出（分支形）暂不支持。

### 2. 引脚推导规则（parser 折叠初稿；展开编辑可手工增删）

对片段代码体做标识符级分析（ts.createSourceFile AST 遍历，非正则）：

| 代码形态 | 推导 |
|---|---|
| 裸标识符读取（未在片段内声明、非环境全局） | in 引脚（type any） |
| `this.X` / `vars.X` 读取 | in 引脚 X（运行时经变量代理解析，回退资产变量） |
| `ui.X`、`plugins.*`、`convert.*`、Math/JSON/Date 等环境全局 | 不推导（运行时环境注入） |
| 片段内 const/let/var/函数/形参声明 | 局部名，不推导 |
| 裸赋值目标 `X = …`（含 `+=`、`++` 等复合，同时计读） | out 引脚 X |
| `return <expr>` | out 引脚 `result` |
| `return { a, b }` | out 引脚 a、b |
| `this.X = …` / `vars.X = …` 写 | **不推导**（资产变量副作用，运行时经变量代理写回，非片段输出值） |

语句级折叠（不可映射语句）在 exec in/out 骨架之上追加推导数据引脚；类成员 / 顶层散件折叠只带推导数据引脚（无 exec 骨架）。推导结果仅是**初稿**——作者在片段编辑器中可增删改引脚。

### 3. 往返重建（codegen ⇄ parser 升级）

生成脚本中片段块的形式（全部新增行都带 `__bps-snippet-*` 标记，解析端按尾注释/行前缀消费，不进入 IRSnippet.code）：

```ts
const __bps_v3 = (this.count + 1);          // __bps-snippet-in(total)      ← 数据入脚别名行（块前）
// __bps-snippet-begin(snip1) {"lang":"ts","pins":[...]}
// __bps-snippet-wiring: let result           ← 出脚声明行（块内首部，解析端剔除）
let result;
<片段源码原样>
// __bps-snippet-end(snip1)
const __bps_v4 = result;                     // __bps-snippet-out(result)    ← 数据出脚别名行（块后）
```

- **in 脚**：有连线取连线源表达式、否则取 pinDefaults 字面量，包一层 `const __bps_vN = <expr>; // __bps-snippet-in(<pinId>)`。解析端按尾注释拦截，**延迟到方法体构建完成后**求值接线（解决纯片段之间的引用顺序）。
- **out 脚**：块内首部发射 `// __bps-snippet-wiring: let <pinId>` + `let <pinId>;`（片段代码以裸名赋值出脚）；被下游引用的出脚在 end 标记后发射 `const __bps_vM = <pinId>; // __bps-snippet-out(<pinId>)`，解析端拦截为「别名 → (片段节点, 引脚)」的具名引用（不经普通别名初始化求值）。
- **纯片段块**提升到方法体顶部发射（脚本顺序执行语义：先求片段、后消费出值）；纯片段之间的 in 脚依赖按数据边拓扑排序。**限制**：纯片段 in 脚只能由可内联表达式源（纯节点链 / 字面量 / 入口参数 / 其他纯片段）供给——「执行节点输出 → 纯片段 in 脚」的连线 codegen 报错（脚本线性顺序无法表达惰性求值；蓝图视图与解释器不受影响，建议改用 exec 片段）。
- 无法从任何入口沿 exec 链到达的「声明了 exec 入」的片段节点：codegen 抛错（与其他执行节点一致的悬空检查）。

### 4. 运行时（specs 注入，不改解释器核心）

解释器按 `spec.inputs` 解析输入、按 `spec.outputs` 校验 exec 出口——片段引脚是**按实例动态**的，静态 spec 无法声明。因此片段运行时走**按资产注入**：

- `src/script/snippet-runtime.ts` 导出 `injectSnippetRuntime(asset, base)`：克隆 base specs，合成片段 spec（引脚 = 该资产全部片段引脚的并集），并返回**类型重写后的资产副本**——纯片段节点 type 改写为 `'script.snippet.pure'`（运行时局部视图，IR 约定不变、往返与编辑不受影响）。两种 spec 各自持有正确的 `pure` 标记，混合资产（同图并存执行/纯片段）由此完整工作。
- `run` 实现：以 IRSnippet.pins 的 in/out 数据引脚 id + T3.2 内建全局（`createScriptGlobals`：ui/vars/emit/print/delay/convert/format/plugins）为形参，`new Function`（严格模式 + async 箭头包裹，无条件支持 await）执行片段代码；`this` 绑定 vars 变量代理。出脚取值：`return` 对象属性优先，否则取同名参数终值（裸赋值出脚）。执行/纯片段共用同一 run。
- 已知边界：解释器执行路径暂只支持 `lang: 'ts'` 片段（py 片段运行时报错提示）；插件桥未接入时 `plugins.*` 抛「插件桥未接入」（T3.2 同语义）。

### 5. 编辑器接线（不修改 store / graph-op-specs / validate）

- **校验 / 连线 / 搜索**依赖 store.specs 中的片段 spec。片段引脚按资产动态，静态注册无法如实声明——由 BlueprintEditorPanel 挂载与资产变化时把「按资产合成的片段 spec（并集）」合并进 store.specs（`setSpecs`），T6.4 插件注入若覆盖会被下次渲染 effect 重合。
- 视图渲染（irToFlow）对 `script.snippet` 节点**始终按资产现算**动态 spec（标题 `片段：<id 前 8 位>`、分类「脚本片段」、引脚按声明），不依赖 store.specs；头变体复用 plugin（紫）。
- 双击展开：`onNodeDoubleClick`（BPGraphCanvas 新增透传 prop）→ 面板打开片段编辑模态（textarea + 引脚表格增删改）→ 保存经 `runCommand('blueprint', …)` 入命令栈（新建片段在同一命令内分配 `snipN` id、创建 IRSnippet 并回填节点 params）。

## 变更影响

- T3.5/T3.6：片段块发射/重建升级（本卡完成，roundtrip 测试锁定）。
- T3.3（脚本沙箱）：脚本执行链如需执行含片段资产，specs 侧同样经 `injectSnippetRuntime` 注入（与 binding.ts 的接线协调归 T3.3/PM）。
- T2.8 校验器：片段节点的并集 spec 存在「纯片段误报 dangling-exec warning」的残留（warning 不阻断保存）；如需精确到实例需校验器支持按节点查 spec，另行 ADR。
- 无存量资产迁移（IRSnippet.pins 骨架已在 T3.5 引入，version 不升）。
