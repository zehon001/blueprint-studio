/**
 * Blueprint Studio v2 —— 脚本内建全局类型声明（T3.2 · PLAN §9.1/§9.2）
 *
 * 用户脚本（.ts 逻辑资产）编辑时的类型来源：T3.1 脚本编辑器把本文件路径注入
 * CodeMirror TS 环境，使内建全局在编辑器中有完整类型、签名与文档提示；
 * 运行时实现见 ./ts.ts（createScriptGlobals，T3.3 沙箱用它构造脚本执行环境），
 * 补全扩展见 ./completion.ts（scriptTypesExtension）。
 *
 * 本文件必须保持「零 import」自包含（编辑器 TS 环境单独加载本文件即可用）：
 * - UI 属性名 UIAttrName 是 src/ui-editor/schema 各 PropDef.id + 公共属性的快照
 *   （T3.2 落盘时的权威清单）；schema 增删属性时同步本清单；
 * - LogRow / UIListRow 与 src/nodes/convert.ts、src/ui-editor/schema/types.ts
 *   的同名结构逐字对齐（复制声明以保证自包含，运行时为同一形状）。
 *
 * 全局注入方式：底部 declare global 块声明 9 个内建全局（ui / vars / emit /
 * onEvent / plugins / print / convert / format / delay）。其中 print 以 function
 * 形式声明——与 lib.dom.d.ts 的 `print(): void` 按重载合并（DOM 环境不冲突，
 * 运行窗口中 print 为脚本控制台输出而非 window.print，见 ts.ts 实现）。
 */

/* ============================================================
 * 0. 共享结构类型（自包含声明，与实现模块结构对齐）
 * ============================================================ */

/**
 * 结构化日志行（与 src/nodes/convert.ts 的 LogRow、手机日志插件 PLAN §14.3 共用同一形状；
 * 用 type 别名声明以保留到 Record<string, unknown> 的隐式索引签名——
 * 使 LogRow[] 可直接赋给 ui.list.items）。
 */
export type LogRow = {
  /** 时间戳（epoch ms；解析失败行为 0） */
  ts: number;
  /** 级别（V/D/I/W/E/F；解析失败行为 ''） */
  level: string;
  /** 标签 */
  tag: string;
  /** 进程号 */
  pid: number;
  /** 消息正文 */
  msg: string;
  /** 原始行 */
  raw: string;
};

/** 列表 / 表格行数据（与 src/ui-editor/schema/types.ts 的 UIListRow 同义；键 = ListColumn.field） */
export type UIListRow = Record<string, unknown>;

/**
 * UI 节点属性名清单（权威来源：src/ui-editor/schema 的 PropDef.id + 公共属性，
 * T3.2 快照；运行时警告与补全从 schema 注册表现取，见 ts.ts 的 knownUIAttrNames）。
 * 分组：公共（name/position/size/rotation/visible/tooltip/expand）+ 各节点业务属性。
 */
export type UIAttrName =
  // 公共属性（commonProps）
  | 'name'
  | 'position'
  | 'size'
  | 'rotation'
  | 'visible'
  | 'tooltip'
  | 'expand'
  // 内容 / 数据
  | 'text'
  | 'value'
  | 'checked'
  | 'items'
  | 'columns'
  | 'title'
  | 'placeholder'
  | 'suffix'
  | 'src'
  | 'fit'
  | 'showPercent'
  | 'activeIndex'
  | 'splitPosition'
  // 外观 / 行为
  | 'variant'
  | 'direction'
  | 'align'
  | 'wrap'
  | 'padding'
  | 'spacing'
  | 'min'
  | 'max'
  | 'step'
  | 'readOnly'
  | 'password';

/**
 * UI 节点属性代理（ui.<节点名> 的返回值）。
 * 常用属性给出具体类型；其余属性经索引签名透传（未知属性运行时 print 提示一次，
 * 仍按原样读写 UiHandle）。
 */
export interface UINodeAttrs {
  /** 显示 / 说明文本（label / button / checkBox 等） */
  text: string;
  /** 当前值（lineEdit 为 string；spinBox / slider 为 number） */
  value: string | number;
  /** 是否勾选（checkBox） */
  checked: boolean;
  /** 是否可见（公共属性，运行态关闭则不渲染） */
  visible: boolean;
  /** 行数据（list / table；元素键对应 columns.field） */
  items: UIListRow[];
  /** 标题（groupBox） */
  title: string;
  /** 占位灰字（lineEdit 等输入类） */
  placeholder: string;
  /** 任意属性透传（与渲染器 PropDef 对齐；未知属性运行时提示） */
  [attr: string]: unknown;
}

/**
 * UI 节点访问器（ui 全局）。
 * - 属性式访问（推荐）：`ui.<节点名>.<属性>` 直接读写——PLAN §9.2 写法
 *   `ui.list.items = rows`；`ui.<节点名>` 指向绑定节点子树中名为该名的节点；
 *   find 失败（无此节点 / 未绑定 UI）返回安全空对象并 print 警告一次，不抛错。
 * - 通用方法：find / read / write 直通 UiHandle（ADR-005），适合动态属性名。
 */
export type UIAccessor = {
  /** 按名查找绑定 UI 子树中的节点；找到返回属性代理，找不到返回 null（并 print 警告一次） */
  find(name: string): UINodeAttrs | null;
  /** 读 UI 节点属性值（直通 UiHandle.read；attr 推荐 UIAttrName 清单内的名字） */
  read(name: string, attr: UIAttrName | (string & {})): unknown;
  /** 写 UI 节点属性值（直通 UiHandle.write） */
  write(name: string, attr: UIAttrName | (string & {}), value: unknown): void;
} & {
  /** 属性式访问：ui.<节点名> → 该节点的属性代理（节点名来自 UI 树，编辑器补全给出候选） */
  [nodeName: string]: UINodeAttrs;
};

/**
 * 资产变量访问器（vars 全局）：Proxy 实现——
 * `vars.x` 读 getVar('x')，`vars.x = v` 写 setVar('x', v)；
 * `Object.keys(vars)` 列出全部变量名（声明变量 + 本实例写入过的变量）。
 * 未声明变量读出 undefined；类型建议配合 convert.* 做显式转换。
 */
export interface VarsAccessor {
  /** 变量名（对应蓝图变量 / @expose 暴露字段） */
  [name: string]: unknown;
}

/**
 * 单个插件的命名空间（plugins.<插件id>）：任意方法调用经代理转发为
 * callPlugin(插件id, 方法名, 参数数组)（T6.4 接 CLI 桥）；本期插件桥未接入时
 * 调用抛「插件桥未接入」。方法返回 Promise，脚本中 `await` 取结果。
 */
export interface PluginNamespace {
  /** 动态方法（由插件清单决定，如 phoneLog.read） */
  [method: string]: (...args: unknown[]) => Promise<unknown>;
}

/** 插件调用访问器（plugins 全局）：plugins.<插件id>.<方法>(...args)，动态两级代理 */
export type PluginsAccessor = Record<string, PluginNamespace>;

/** 脚本自定义事件监听器（onEvent 的 handler；args 为事件参数对象，按键名取值） */
export type ScriptEventHandler = (args: unknown) => void;

/**
 * 类型转换 API（convert 全局）——语义与 src/nodes/convert.ts 转换节点逐一对齐
 * （实现直接复用节点 run，见 ts.ts）；解析失败一律安全降级，不抛错。
 */
export interface ConvertApi {
  /** 转 float：boolean → 1/0；无法解析（含 NaN）返回 0（convert.toNumber 节点同语义） */
  toNumber(value: unknown): number;
  /** 转文本：null / undefined → 空串（convert.toString 节点同语义） */
  toString(value: unknown): string;
  /** 转布尔：数字非 0、字符串 true/1/yes/on 为真，其余为假（convert.toBool 节点同语义） */
  toBool(value: unknown): boolean;
  /** 整数前缀解析（"12abc" → 12）；数值截断；无法解析返回 0（convert.parseInt 节点同语义） */
  parseInt(value: unknown): number;
  /** JSON 解析：失败返回 null（convert.jsonParse 节点同语义） */
  jsonParse(text: string): unknown;
  /** JSON 序列化（缩进 2）：失败返回空串（convert.jsonStringify 节点同语义） */
  jsonStringify(value: unknown): string;
  /**
   * epoch 毫秒 → 文本；令牌 YYYY/MM/DD/HH/mm/SS（mm 为分钟）。
   * epoch ≤ 0 时取当前时间；fmt 缺省 'MM-DD HH:mm:SS'（convert.timeFormat 节点同语义）。
   */
  timeFormat(epochMs: number, fmt?: string): string;
  /**
   * 多行 Android 日志 → LogRow[]（ts/level/tag/pid/msg/raw）；
   * 兼容 logcat -v time 与 epoch 前缀两种格式，解析失败行保留 raw、ts=0；
   * levelFilter 可选（'V'/'D'/'I'/'W'/'E'/'F'，空 = 不过滤）（convert.androidLogParse 节点同语义）。
   */
  androidLogParse(lines: string | string[], levelFilter?: string): LogRow[];
}

/* ============================================================
 * 1. 全局环境（createScriptGlobals 的返回值 = 用户脚本可见的全部内建全局）
 * ============================================================ */

/** 脚本内建全局集合（types.d.ts 的 declare global 与本接口逐字段一致） */
export interface ScriptGlobals {
  /** UI 节点访问器：ui.<节点名>.<属性> 属性式读写；ui.find/read/write 通用访问 */
  ui: UIAccessor;
  /** 资产变量访问器：vars.x 读 / vars.x = v 写；Object.keys(vars) 列出全部 */
  vars: VarsAccessor;
  /** 发送自定义事件（对齐 event.send 节点参数规范化，见下方 declare global 文档） */
  emit(name: string, ...args: unknown[]): void;
  /** 监听事件（@on 注解的运行时形态） */
  onEvent(name: string, handler: ScriptEventHandler): void;
  /** 插件调用命名空间：await plugins.<插件id>.<方法>(...args) */
  plugins: PluginsAccessor;
  /** 打印到运行窗口控制台 */
  print(...parts: unknown[]): void;
  /** 读项目内文件文本（path 相对项目根，如 'assets/sample.log'）；钩子缺失降级返回空串 */
  readFile(path: string): Promise<string>;
  /** 类型转换 API（与转换节点同语义） */
  convert: ConvertApi;
  /** 格式化文本：{0} {1}… 占位符，缺参替换为空串（string.format 节点同语义） */
  format(template: string, ...args: unknown[]): string;
  /** 异步延时（await delay(ms)）；不阻塞其他事件队列 */
  delay(ms: number): Promise<void>;
}

/* ============================================================
 * 2. 环境注入（对用户脚本可见的全局绑定）
 * ============================================================ */

declare global {
  /**
   * UI 节点访问器：ui.<节点名> 指向绑定节点子树中名为 <节点名> 的节点，
   * `.text/.value/.checked/.visible/.items` 等属性直接读写（如 ui.list.items = rows）。
   * 未知节点返回安全空对象并 print 警告一次；通用访问用 ui.find / ui.read / ui.write。
   */
  var ui: UIAccessor;
  /**
   * 资产变量访问器（Proxy）：vars.x 读 getVar('x')，vars.x = v 写 setVar('x', v)；
   * Object.keys(vars) 列出全部变量名。未声明变量读出 undefined。
   */
  var vars: VarsAccessor;
  /**
   * 发送自定义事件（等价蓝图「发送事件」节点）。参数规范化与 event.send 节点一致：
   * - emit(name, { a: 1 })   → 事件参数按键名展开；
   * - emit(name, [1, 2])     → 打包为 { args: [1, 2] }；
   * - emit(name, 5)          → 打包为 { value: 5 }；
   * - emit(name, a, b, c)    → 位置式 { arg0: a, arg1: b, arg2: c }（引擎占位脚命名）。
   */
  function emit(name: string, ...args: unknown[]): void;
  /**
   * 监听事件（等价蓝图「监听事件」节点 / @on 注解的运行时形态）。
   * 事件到达时以参数对象调用 handler；onEventRegister 未接入时 print 提示并忽略。
   */
  function onEvent(name: string, handler: (args: unknown) => void): void;
  /**
   * 插件调用命名空间（动态两级代理）：await plugins.<插件id>.<方法>(...args)，
   * 例：await plugins.phoneLog.read({ mode: 'adb', filter: 'com.demo.app' })。
   * 插件桥（ScriptGlobalsOptions.callPlugin，T6.4 CLI 桥）未接入时调用抛「插件桥未接入」。
   */
  var plugins: PluginsAccessor;
  /**
   * 打印到运行窗口控制台（旁路直调，不入事件队列）。
   * 以 function 声明与 lib.dom 的 print(): void 重载合并；运行窗口中为本脚本控制台输出。
   */
  function print(...parts: unknown[]): void;
  /** 读项目内文件文本（system.readFile 节点同语义；失败安全降级返回空串） */
  function readFile(path: string): Promise<string>;
  /**
   * 类型转换 API（与 src/nodes/convert.ts 转换节点同语义，解析失败安全降级不抛错）：
   * - convert.toNumber(v) / toBool(v) / parseInt(v) / toString(v)：类型转换（失败 → 0 / false / 空串）；
   * - convert.jsonParse(text) / jsonStringify(v)：JSON 解析（失败 null）与序列化（缩进 2）；
   * - convert.timeFormat(epochMs, fmt?)：epoch 毫秒 → 文本（令牌 YYYY/MM/DD/HH/mm/SS，mm 为分钟）；
   * - convert.androidLogParse(lines, levelFilter?)：多行 Android 日志 → LogRow[]（失败行保留 raw）。
   */
  var convert: ConvertApi;
  /**
   * 格式化文本（string.format 节点同语义）：{0} {1}… 占位符替换为对应参数；
   * 缺参 / null / undefined 替换为空串。例：format('共 {0} 行', rows.length)。
   */
  function format(template: string, ...args: unknown[]): string;
  /**
   * 异步延时：await delay(500)（毫秒）。不阻塞其他事件队列；
   * 运行窗口停止时以 AbortError reject（长循环应响应停止）。
   */
  function delay(ms: number): Promise<void>;
}
