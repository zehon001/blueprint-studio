/**
 * Blueprint Studio v2 —— 全局契约类型（唯一真源）
 *
 * 本文件固化四类契约，编辑器 / 运行窗口 / 本地服务一律从这里 import，不得重复声明：
 *  1. 统一 IR（逻辑资产中间表示）        —— docs/v2/adr/001-ir.md（PLAN §5）
 *  2. 项目文件格式（project.json / UI 资产）—— docs/v2/adr/002-project-file.md（PLAN §4）
 *  3. NodeSpec（节点定义与运行契约）      —— docs/v2/adr/003-nodespec.md（PLAN §13）
 *  4. 插件清单与注册表                   —— docs/v2/adr/004-plugin-manifest.md（PLAN §14）
 *
 * 契约级变更（字段增删、语义修改）必须先在 docs/v2/adr/ 落 ADR 并由 PM-Agent 知会，
 * 再修改本文件；禁止绕过 ADR 直接改类型。
 */

/* ============================================================
 * 0. 通用基础类型
 * ============================================================ */

/** 二维向量（蓝图画布坐标 / UI 节点位置共用） */
export interface Vec2 {
  /** 横坐标（像素） */
  x: number;
  /** 纵坐标（像素） */
  y: number;
}

/** 宽高尺寸（UI 节点用） */
export interface Size2 {
  /** 宽（像素） */
  w: number;
  /** 高（像素） */
  h: number;
}

/* ============================================================
 * 1. 统一 IR（docs/v2/adr/001-ir.md，PLAN §5）
 * ============================================================ */

/** IR 格式当前版本（IRAsset.version 的当前值；格式变更必须走 ADR） */
export const IR_VERSION = 2;

/** IR 内置原语类型 */
export type IRPrimitiveType =
  /** 执行流引脚（只允许出现在引脚上；变量 / 参数禁止） */
  | 'exec'
  /** 布尔 */
  | 'bool'
  /** 整数 */
  | 'int'
  /** 浮点数（PLAN §5 示例中的 "number" 在本契约定型为 float） */
  | 'float'
  /** 字符串 */
  | 'string'
  /** 通用对象（结构未声明时的兜底对象类型） */
  | 'object'
  /** 任意类型（数据连线双向可赋值） */
  | 'any';

/** IR 数组类型（`元素类型[]`，如 'string[]'、'LogRow[]'） */
export type IRArrayType = `${string}[]`;

/**
 * IR 引脚 / 变量 / 参数的统一值类型。
 * - 内置原语：见 {@link IRPrimitiveType}；
 * - 数组：任意元素类型加 `[]` 后缀（如 'string[]'）；
 * - 自定义对象类型：字符串别名（如 'LogRow'、'file'），由节点库 / 插件声明并按名引用，
 *   解释器不做结构展开。
 */
export type IRValueType = IRPrimitiveType | IRArrayType | (string & {});

/** 内置原语类型清单（isPrimitiveType 的运行时依据） */
const PRIMITIVE_TYPES: readonly IRPrimitiveType[] = [
  'exec',
  'bool',
  'int',
  'float',
  'string',
  'object',
  'any',
];

/** 是否为内置原语类型（排除数组与自定义别名） */
export function isPrimitiveType(t: IRValueType): boolean {
  return (PRIMITIVE_TYPES as readonly string[]).includes(t);
}

/** 是否为 exec 引脚类型（exec 只能出现在引脚上，变量 / 事件参数 / 函数参数禁止使用） */
export function isExecType(t: IRValueType): boolean {
  return t === 'exec';
}

/** 是否为任意类型（数据连线双向可赋值） */
export function isAnyType(t: IRValueType): boolean {
  return t === 'any';
}

/** 是否为数组类型（含自定义对象数组，如 'LogRow[]'） */
export function isArrayType(t: IRValueType): t is IRArrayType {
  return typeof t === 'string' && t.endsWith('[]') && t.length > 2;
}

/** 取数组元素类型；非数组类型原样返回（恒等） */
export function elementType(t: IRValueType): IRValueType {
  return isArrayType(t) ? ((t.slice(0, -2) as IRValueType)) : t;
}

/** 是否为标量数值类型（int / float；数组返回 false，判断数组元素请先 elementType） */
export function isNumericType(t: IRValueType): boolean {
  return t === 'int' || t === 'float';
}

/**
 * 数据连线类型可赋值判定（蓝图校验器 T2.8 / 自动转换节点 T2.2 的基础规则）：
 * 1. 完全相同 → 可赋值；
 * 2. 任一侧为 any → 可赋值；
 * 3. int → float → 可赋值（数值加宽）；
 * 4. 数组 → 数组：元素类型可赋值即可（数组同形）；
 * 5. 其余（含 exec 与数据类型互连、不同名自定义别名）→ 不可直接赋值，需显式转换节点。
 */
export function isTypeAssignable(from: IRValueType, to: IRValueType): boolean {
  if (from === to) return true;
  if (from === 'any' || to === 'any') return true;
  if (from === 'int' && to === 'float') return true;
  if (isArrayType(from) && isArrayType(to)) {
    return isTypeAssignable(elementType(from), elementType(to));
  }
  return false;
}

/** 函数入参 / 函数返回值 / 事件参数的声明项 */
export interface IRParamSpec {
  /** 参数名（同声明处唯一；脚本视图 codegen 后即形参名） */
  name: string;
  /** 参数类型（数据类型，禁止 exec） */
  type: IRValueType;
}

/** 连线端点（节点实例 id + 引脚 id） */
export interface IREndpoint {
  /** 端点所在节点实例 id（同图内，引用 IRNode.id） */
  node: string;
  /** 端点引脚 id（引用 NodeSpec 输入 / 输出 PinSpec.id） */
  pin: string;
}

/** 蓝图节点实例（图中的一个节点） */
export interface IRNode {
  /** 节点实例 id（同图内唯一） */
  id: string;
  /** 节点类型：NodeSpec.id（内置节点见 src/nodes/，插件节点带插件 id 前缀） */
  type: string;
  /** 覆盖显示标题（省略时用 NodeSpec.title） */
  title?: string;
  /** 节点参数值（键 = ParamSpec.id；解释器与 ParamSpec.default 合并后经 ctx.params 提供） */
  params: Record<string, unknown>;
  /** 未连线输入引脚的内联默认值（键 = PinSpec.id；未声明的引脚回落 PinSpec.defaultValue） */
  pinDefaults: Record<string, unknown>;
  /** 节点注释（节点头下方显示的小字说明） */
  comment?: string;
  /** 画布坐标（蓝图视图布局） */
  position: Vec2;
}

/** 蓝图连线（有向：from → to） */
export interface IREdge {
  /** 边 id（同图内唯一） */
  id: string;
  /** 起点（输出侧引脚） */
  from: IREndpoint;
  /** 终点（输入侧引脚） */
  to: IREndpoint;
  /** 边类型：exec=执行流（白实线）；data=数据流（彩虚线）。exec 链不能穿过纯节点 */
  kind: 'exec' | 'data';
}

/** 蓝图变量 */
export interface IRVariable {
  /** 变量名（资产内唯一；脚本视图为类字段名） */
  name: string;
  /** 变量类型（数据类型，禁止 exec） */
  type: IRValueType;
  /** 默认值（省略 = 类型零值，由解释器决定） */
  default?: unknown;
  /** 是否暴露：勾选后自动生成 Get/Set 节点，脚本视图生成 @expose 注解 */
  exposed?: boolean;
  /** 分类（结构面板 My Blueprint 分组显示） */
  category?: string;
}

/** 自定义事件定义（发送事件 / 监听事件节点的目标） */
export interface IREventDef {
  /** 事件名（资产内唯一） */
  name: string;
  /** 事件参数（有序；emit 时按键名传值） */
  params: IRParamSpec[];
}

/** 脚本片段节点的引脚声明 */
export interface IRSnippetPin {
  /** 引脚 id（片段内唯一） */
  id: string;
  /** 方向：in=输入 / out=输出 */
  dir: 'in' | 'out';
  /** 引脚类型（可含 exec：片段可声明 exec 入 / exec 出） */
  type: IRValueType;
  /** 引脚显示名（省略时显示 id） */
  label?: string;
}

/** 脚本片段节点（蓝图⇄脚本互转中不可映射段的兜底容器，PLAN §10） */
export interface IRSnippet {
  /** 片段 id（资产内唯一；图中的片段节点经自身 params 引用该 id，挂接细节由 T3.7 定） */
  id: string;
  /** 片段语言 */
  lang: 'ts' | 'py';
  /** 片段源码（往返无损的载荷，原样保留） */
  code: string;
  /** 片段对外引脚声明（codegen 时生成调用签名，解析时恢复引脚） */
  pins: IRSnippetPin[];
}

/** 图的视图状态（仅蓝图视图使用，不参与解释；roundtrip 测试可忽略） */
export interface IRGraphLayout {
  /** 缩放倍率 */
  zoom: number;
  /** 平移偏移 [x, y]（画布坐标） */
  pan: [number, number];
}

/** 一张图（主图或函数子图） */
export interface IRGraph {
  /** 节点实例列表 */
  nodes: IRNode[];
  /** 连线列表 */
  edges: IREdge[];
  /** 函数入参声明（仅函数子图；主图省略。函数入口节点据此渲染引脚） */
  params?: IRParamSpec[];
  /** 函数返回值声明（仅函数子图；主图省略。函数出口节点据此渲染引脚） */
  returns?: IRParamSpec[];
}

/** 逻辑资产 IR（.bp.json 的序列化对象；蓝图 / TS / Python 三种资产共用的内存表示） */
export interface IRAsset {
  /** IR 格式版本（迁移判定用，当前 = IR_VERSION） */
  version: 2;
  /** 资产名（如 '日志查看器'；默认与文件名一致） */
  name: string;
  /** 主图名（graphs 的键；绑定 UI 节点时作为事件入口图） */
  entry: string;
  /** 图集合：主图 + 函数子图（键 = 图名 / 函数名，函数名即 codegen 后的方法名） */
  graphs: Record<string, IRGraph>;
  /** 变量表 */
  variables: IRVariable[];
  /** 自定义事件表 */
  events: IREventDef[];
  /** 脚本片段列表（不可映射段兜底，通常由脚本解析器生成） */
  snippets: IRSnippet[];
  /** 各图视图状态（键 = 图名） */
  layout: Record<string, IRGraphLayout>;
}

/**
 * IR 版本迁移入口（预留接口）。
 * 当前 IR_VERSION = 2 为初始版本：直通返回，不做校验。
 * 后续格式变更时：在此按 version 链式调用各版本迁移函数（每步迁移方案在对应 ADR 中定义），
 * 迁移后 version 必须等于 IR_VERSION。
 */
export function migrateIR(raw: unknown): IRAsset {
  // 初始版本直通；版本判断与迁移链在首次 IR 格式变更时引入（docs/v2/adr/001-ir.md 变更流程）
  return raw as IRAsset;
}

/* ============================================================
 * 2. 项目文件格式（docs/v2/adr/002-project-file.md，PLAN §4）
 * ============================================================ */

/** project.json —— 工具项目描述文件（项目根目录；文件夹即项目） */
export interface ProjectFile {
  /** 项目名（显示名，可含中文） */
  name: string;
  /** 主 UI 资产路径（相对项目根，如 'ui/main.ui.json'；F5 运行的入口） */
  mainUI: string;
  /** 创建项目时的引擎版本（升级兼容检查用） */
  engineVersion: string;
  /** 已启用插件表（键 = 插件 id，值 = 是否启用；未列出的插件视为未启用） */
  plugins: Record<string, boolean>;
}

/** UI 节点锚点（骨架）：键与语义由 T1.1 的属性 schema 细化后替换为具体类型 */
export type UIAnchors = Record<string, number>;

/** UI 节点的变换属性（容器布局优先时，子项的 size / position 可能被布局覆盖） */
export interface UITransform {
  /** 位置（相对父节点坐标系，像素） */
  position: Vec2;
  /** 尺寸（像素） */
  size: Size2;
  /** 旋转角度（度，顺时针） */
  rotation: number;
  /** 锚点（骨架，具体 schema 由 T1.1 细化；容器布局的子项通常省略） */
  anchors?: UIAnchors;
}

/** UI 节点（*.ui.json 资产树中的一个节点） */
export interface UINode {
  /** 节点实例 id（资产内唯一） */
  id: string;
  /** 树内唯一名（ui 访问器的查找键：ui.<name> 即绑定节点子树中名为 name 的节点） */
  name: string;
  /** UI 节点类型（PLAN §7.1 节点库，如 vbox / button / list；类型枚举由 T1.1 schema 定义） */
  type: string;
  /** 变换属性 */
  transform: UITransform;
  /** 主题样式属性（键 = T1.1 属性 schema 定义的样式名） */
  theme: Record<string, unknown>;
  /** 业务属性（键 = T1.1 属性 schema 定义的属性名） */
  props: Record<string, unknown>;
  /** 绑定的事件名列表（事件面板展示与跳转用） */
  events?: string[];
  /** 挂载的逻辑资产路径（相对项目根，如 'logic/main.bp.json'） */
  logicAsset?: string;
  /** 子节点列表（叶子节点为空数组） */
  children: UINode[];
}

/** UI 资产（*.ui.json 的序列化对象） */
export interface UIAsset {
  /** 资产格式版本（当前 = 2；变更走 ADR） */
  version: 2;
  /** 资产名（默认与文件名一致） */
  name: string;
  /** UI 树根节点 */
  root: UINode;
}

/* ============================================================
 * 3. NodeSpec（docs/v2/adr/003-nodespec.md，PLAN §13）
 * ============================================================ */

/** 检视器参数编辑器种类（内置五种；扩展新种类须同步检视器实现并记 ADR） */
export type ParamType = 'number' | 'string' | 'bool' | 'select' | 'color' | (string & {});

/** 下拉选项（select 型引脚 / select 型参数共用） */
export interface ParamOption {
  /** 提交值（存入 IR 的值） */
  value: string;
  /** 显示名（下拉列表展示） */
  label: string;
}

/** 检视器节点参数声明（不参与连线的配置项，仅检视器编辑） */
export interface ParamSpec {
  /** 参数 id（同节点内唯一；IRNode.params 的键） */
  id: string;
  /** 检视器显示名 */
  label: string;
  /** 编辑器种类 */
  type: ParamType;
  /** 下拉选项（type = 'select' 时必填） */
  options?: ParamOption[];
  /** 默认值（检视器初值；解释器合并进 ctx.params） */
  default?: unknown;
  /** 检视器分组名（同组参数折叠显示；省略归入默认组） */
  group?: string;
}

/** 蓝图引脚声明（输入 / 输出通用） */
export interface PinSpec {
  /** 引脚 id（同节点内唯一；exec 引脚惯例命名 'exec'，多出口按语义命名如 'true' / 'false'） */
  id: string;
  /** 引脚类型（exec 引脚必须显式写 'exec'；数据引脚为 IRValueType） */
  type: IRValueType;
  /** 引脚显示名（省略时显示 id） */
  label?: string;
  /** 是否可选（可选引脚未连线不阻塞执行） */
  optional?: boolean;
  /** 是否允许多条连线汇入（数组式聚合，运行时语义由解释器 T2.5 落地） */
  multi?: boolean;
  /** 下拉选项（select 型引脚用；已连线时连线值优先于下拉选择） */
  options?: ParamOption[];
  /** 内联默认值（未连线时作为输入值，引脚上可内联编辑；IRNode.pinDefaults 的初值来源） */
  defaultValue?: unknown;
}

/** 节点运行上下文（解释器构造，NodeRunFn 第一参数） */
export interface NodeRunContext {
  /** 当前执行的节点实例 id（调试观察 / 高亮上报用） */
  nodeId: string;
  /** 节点参数（IRNode.params 与 ParamSpec.default 合并后的最终值） */
  params: Record<string, unknown>;
  /** 读资产变量（未声明变量返回 undefined） */
  getVar(name: string): unknown;
  /** 写资产变量（暴露变量的写入会同步到绑定 UI） */
  setVar(name: string, value: unknown): void;
  /** 发送自定义事件（params 的键 = IREventDef.params 的 name） */
  emit(event: string, params?: Record<string, unknown>): void;
  /** 打印到运行窗口控制台（对应脚本全局 print） */
  print(...parts: unknown[]): void;
  /** 异步延时（不阻塞其他事件队列；对应脚本全局 delay） */
  delay(ms: number): Promise<void>;
  /** 运行中止信号（运行窗口关闭 / 手动停止时置位；长任务节点应响应） */
  signal: AbortSignal;
}

/** 节点单次执行结果 */
export interface NodeRunResult {
  /** 激活的 exec 出口引脚 id；节点只有一个 exec 出口时可省略（解释器取唯一出口）；纯节点忽略 */
  next?: string;
  /** 输出引脚值（键 = 输出 PinSpec.id；解释器据此向下游传播） */
  outputs: Record<string, unknown>;
}

/**
 * 节点运行函数（NodeSpec.run 的类型）。
 * - 仅运行窗口侧调用（IR 解释器 T2.5 / 脚本沙箱 T3.3）；编辑器共用同一 NodeSpec 定义模块，
 *   但只读取 spec 结构做渲染与校验，不执行 run。
 * - inputs 由解释器组装：已连线输入取连线传值；未连线输入取 IRNode.pinDefaults，缺省回落
 *   PinSpec.defaultValue；multi 引脚聚合为数组。
 * - 同步节点直接返回 NodeRunResult；异步节点返回 Promise（解释器 await，但不阻塞其他事件队列）。
 */
export type NodeRunFn = (
  ctx: NodeRunContext,
  inputs: Record<string, unknown>,
) => NodeRunResult | Promise<NodeRunResult>;

/**
 * 节点定义（声明式，src/nodes/ 定义节点的唯一写法；插件节点同构复用，见 PluginNodeSpec）。
 * 运行契约与示例见 docs/v2/adr/003-nodespec.md。
 */
export interface NodeSpec {
  /** 节点 id：内置节点用 '分类前缀.名称'（如 'flow.branch'）；插件节点必须带插件 id 前缀（如 'phoneLog.read'） */
  id: string;
  /** 节点标题（节点头显示；IRNode.title 可覆盖） */
  title: string;
  /** 分类（节点头配色 + 右键搜索分组） */
  category: string;
  /** 右键搜索的模糊匹配关键词 */
  keywords?: string[];
  /** 输入引脚（含 exec 入） */
  inputs: PinSpec[];
  /** 输出引脚（含 exec 出） */
  outputs: PinSpec[];
  /** 检视器参数声明（不参与连线的配置项） */
  params?: ParamSpec[];
  /** 是否纯节点：无副作用、无 exec 引脚、可被 codegen 内联为表达式（exec 链不得穿过纯节点） */
  pure?: boolean;
  /** 节点运行函数（解释器执行该节点时调用；纯节点求值同样走 run，next 被忽略） */
  run?: NodeRunFn;
  /** 节点说明文档（蓝图检视器 / 帮助浮层显示） */
  doc?: string;
}

/* ============================================================
 * 4. 插件清单与注册表（docs/v2/adr/004-plugin-manifest.md，PLAN §14）
 * ============================================================ */

/** 插件安装策略（服务端执行器 T6.3 按策略生成命令；可在设置中被覆盖） */
export type InstallStrategy = 'winget' | 'npm-global' | 'download-zip' | 'custom-cmd';

/** 外部 CLI 检测命令（检测失败 = 未安装） */
export interface DetectSpec {
  /** 检测命令（如 'adb version'） */
  cmd: string;
  /** 从命令输出提取版本号的正则（第一个捕获组为版本；省略则不判定版本） */
  versionRegex?: string;
}

/** 安装命令声明 */
export interface InstallSpec {
  /** 安装策略 */
  strategy: InstallStrategy;
  /** 策略参数（winget=包 id；npm-global=包名；download-zip=下载地址等，具体语义由 T6.3 落地） */
  args?: string[];
  /** 自定义命令（strategy = 'custom-cmd' 时必填） */
  cmd?: string;
}

/** 更新信息（版本判定：detect 解析的当前版本 vs latestVersion） */
export interface UpdateSpec {
  /** 最新版本号（用于判定「已安装·最新 / 可更新」） */
  latestVersion: string;
  /** 版本信息来源（如 'registry' 或 URL；展示与人工核对用） */
  source: string;
}

/**
 * 插件节点 = NodeSpec 同构 + kind 标记；id 必须带插件 id 前缀（如 'phoneLog.read'）。
 * 经 src/nodes/dynamic.ts 注册后与内置节点完全同权（同样有 exec / 数据引脚）。
 */
export type PluginNodeSpec = NodeSpec & {
  /** 节点性质：action=常规动作节点（默认，有 exec 入/出）；event=持续流事件节点（推送驱动：无 exec 入口，有 exec 出口） */
  kind?: 'action' | 'event';
};

/** 插件清单（内置注册表 / 项目 plugins/ / 服务端静态目录 使用同一格式） */
export interface PluginManifest {
  /** 插件 id（全局唯一；插件节点 id 必须以它为前缀） */
  id: string;
  /** 插件显示名 */
  name: string;
  /** 插件种类：cli=封装已存在的外部 CLI（只做检测/安装/更新 + 节点封装）；custom=自定义插件（可带服务端执行器 executor.cjs） */
  kind: 'cli' | 'custom';
  /** 插件描述（管理界面列表显示） */
  description: string;
  /** 安装检测（省略 = 不做检测，直接按已安装处理——自定义插件通常省略） */
  detect?: DetectSpec;
  /** 安装命令（省略 = 不提供安装，管理界面只提示手动安装） */
  install?: InstallSpec;
  /** 更新信息（省略 = 不参与版本判定，状态恒为「已安装」） */
  update?: UpdateSpec;
  /** 插件封装的节点列表 */
  nodes: PluginNodeSpec[];
  /** 清单来源（由注册表按发现位置标注后附加，不在清单 JSON 中手写） */
  source?: 'builtin' | 'project' | 'static';
}

/** 注册表条目（= 插件清单；三源合并去重后注册表中的条目） */
export type PluginRegistryEntry = PluginManifest;

/**
 * 三源注册表合并去重（签名预留，合并优先级语义由 T6.1 定案）。
 * lists 按优先级顺序传入：[内置 plugins-registry/, 项目 plugins/, 服务端静态目录]。
 * 当前实现：按插件 id 先到先得（优先级高的源覆盖同名清单）；返回新数组，不修改入参。
 */
export function mergeManifests(lists: PluginManifest[][]): PluginManifest[] {
  const seen = new Set<string>();
  const merged: PluginManifest[] = [];
  for (const list of lists) {
    for (const manifest of list) {
      if (seen.has(manifest.id)) continue;
      seen.add(manifest.id);
      merged.push(manifest);
    }
  }
  return merged;
}
