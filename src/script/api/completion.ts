/**
 * Blueprint Studio v2 —— 脚本内建全局 CodeMirror 补全扩展（T3.2 × T3.1 咬合点）
 *
 * T3.1 脚本编辑器 `import { scriptTypesExtension } from '@/script/api'` 加进扩展列表即可：
 * 内建全局（ui/vars/emit/onEvent/plugins/print/convert/format/delay）与成员
 * （convert.xxx / plugins.<id> / ui.<节点>.<属性>）作为补全项，签名在 detail、
 * JSDoc 同源文档在 info（悬浮展示）。
 *
 * 接入说明（两档，按 T3.1 的编辑器配置二选一）：
 *  - scriptTypesExtension()：把补全源注册进全局 languageData（`autocomplete` 属性），
 *    与编辑器已有的 autocompletion()（basicSetup 默认含）自然组合，不覆盖其他补全源；
 *  - 需要完全接管补全时：用导出的 scriptCompletionSource 接入
 *    `autocompletion({ override: [scriptCompletionSource] })`。
 *
 * 属性清单取自 src/ui-editor/schema（PropDef.id 权威来源，经 ts.ts 的
 * knownUIAttrNames 与「未知属性警告」共用同一集合）；文档取各 PropDef.doc。
 * UI 节点名 / 插件 id 是资产级动态数据，经 ScriptCompletionOptions 注入
 *（缺省补全本期必做插件 phoneLog，不补全节点名）。
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { uiNodeSchemas } from '@/ui-editor/schema';
import { knownUIAttrNames } from './ts';

/** 补全扩展的可选配置（资产级动态数据；缺省给出无资产上下文的通用补全） */
export interface ScriptCompletionOptions {
  /** UI 节点名清单（ui.<节点名> 一级补全用；来自当前 UI 资产树。缺省不补全一级节点名） */
  uiNames?: readonly string[];
  /** 已启用插件 id（plugins.<id> 补全用；缺省 ['phoneLog']——本期唯一必做插件，PLAN §14.3） */
  pluginIds?: readonly string[];
}

/* ============================================================
 * 1. 补全项表（detail = 签名，info = 文档；与 types.d.ts JSDoc 同源措辞）
 * ============================================================ */

/** 顶层内建全局（9 项，与 types.d.ts declare global 一一对应） */
const GLOBAL_COMPLETIONS: Completion[] = [
  {
    label: 'ui',
    type: 'variable',
    detail: 'UIAccessor',
    info: 'UI 节点访问器：ui.<节点名>.<属性> 直接读写（如 ui.list.items = rows、ui.title.text = "你好"）；ui.find/read/write 通用访问；未知节点返回安全空对象并提示一次。',
  },
  {
    label: 'vars',
    type: 'variable',
    detail: 'VarsAccessor',
    info: '资产变量访问器：vars.x 读 getVar("x")，vars.x = v 写 setVar；Object.keys(vars) 列出全部变量名。',
  },
  {
    label: 'emit',
    type: 'function',
    detail: 'emit(name, ...args): void',
    info: '发送自定义事件（等价「发送事件」节点）。对象参数按键名展开；数组打包为 { args }；单值打包为 { value }；多参数位置式 arg0~argN。',
  },
  {
    label: 'onEvent',
    type: 'function',
    detail: 'onEvent(name, handler): void',
    info: '监听事件（等价「监听事件」节点 / @on 注解的运行时形态）；事件到达时以参数对象调用 handler。',
  },
  {
    label: 'plugins',
    type: 'variable',
    detail: 'PluginsAccessor',
    info: '插件调用命名空间：await plugins.<插件id>.<方法>(...args)，如 await plugins.phoneLog.read({ mode: "adb" })；插件桥未接入时调用抛「插件桥未接入」。',
  },
  {
    label: 'print',
    type: 'function',
    detail: 'print(...parts): void',
    info: '打印到运行窗口控制台（旁路直调，不入事件队列）。',
  },
  {
    label: 'convert',
    type: 'variable',
    detail: 'ConvertApi',
    info: '类型转换 API（toNumber/toString/toBool/parseInt/jsonParse/jsonStringify/timeFormat/androidLogParse），与转换节点同语义，解析失败安全降级不抛错。',
  },
  {
    label: 'format',
    type: 'function',
    detail: 'format(template, ...args): string',
    info: '格式化文本：format("共 {0} 行", n) —— {0} {1}… 占位符，缺参替换为空串（string.format 节点同语义）。',
  },
  {
    label: 'delay',
    type: 'function',
    detail: 'delay(ms): Promise<void>',
    info: '异步延时：await delay(500)；不阻塞其他事件队列，运行中止时以 AbortError reject。',
  },
];

/** convert.<fn> 成员（签名与 types.d.ts ConvertApi 对齐，语义 = 同名转换节点） */
const CONVERT_COMPLETIONS: Completion[] = [
  { label: 'toNumber', type: 'function', detail: 'toNumber(value: unknown): number', info: '转 float：boolean → 1/0；无法解析（含 NaN）返回 0。' },
  { label: 'toString', type: 'function', detail: 'toString(value: unknown): string', info: '转文本：null / undefined → 空串。' },
  { label: 'toBool', type: 'function', detail: 'toBool(value: unknown): boolean', info: '转布尔：数字非 0、字符串 true/1/yes/on 为真，其余为假。' },
  { label: 'parseInt', type: 'function', detail: 'parseInt(value: unknown): number', info: '整数前缀解析（"12abc" → 12）；无法解析返回 0。' },
  { label: 'jsonParse', type: 'function', detail: 'jsonParse(text: string): unknown', info: 'JSON 解析；失败返回 null。' },
  { label: 'jsonStringify', type: 'function', detail: 'jsonStringify(value: unknown): string', info: 'JSON 序列化（缩进 2）；失败返回空串。' },
  { label: 'timeFormat', type: 'function', detail: 'timeFormat(epochMs: number, fmt?: string): string', info: 'epoch 毫秒 → 文本；令牌 YYYY/MM/DD/HH/mm/SS（mm 为分钟）；epoch ≤ 0 取当前时间。' },
  { label: 'androidLogParse', type: 'function', detail: 'androidLogParse(lines, levelFilter?): LogRow[]', info: '多行 Android 日志 → LogRow[]（ts/level/tag/pid/msg/raw）；兼容 logcat -v time 与 epoch 前缀，失败行保留 raw、ts=0。' },
];

/** plugins.<插件id>.<method> 的方法清单（按插件静态登记；动态方法经代理透传仍可调用） */
const PLUGIN_METHODS: Readonly<Record<string, Completion[]>> = {
  // 手机日志插件（PLAN §14.3，本期唯一必做）：dump / 文件两种模式读取
  phoneLog: [
    {
      label: 'read',
      type: 'method',
      detail: 'read(options?): Promise<LogRow[]>',
      info: '读取手机日志：{ mode: "adb" | "file", filter?: 包名, files?: 路径[] }；返回结构化日志行（convert.androidLogParse 同构）。',
    },
  ],
};

/** UI 属性补全（清单 = knownUIAttrNames；文档 = 各 schema PropDef.doc 首个非空者） */
function attrCompletions(): Completion[] {
  const docById = new Map<string, string>();
  for (const schema of uiNodeSchemas) {
    for (const def of schema.props) {
      if (!docById.has(def.id) && def.doc) docById.set(def.id, def.doc);
    }
  }
  return knownUIAttrNames().map((id) => ({
    label: id,
    type: 'property',
    detail: 'UI 属性',
    info: docById.get(id) ?? 'UI 节点属性（与渲染器 PropDef 对齐，读写直通 UiHandle）',
  }));
}

/* ============================================================
 * 2. 补全源
 * ============================================================ */

/**
 * 构造脚本补全源（可传资产级 uiNames / pluginIds 精化）。
 * 上下文识别：顶层标识符 → 9 全局；`convert.` → 转换函数；
 * `plugins.<id>` / `plugins.<id>.<method>` → 插件命名空间与方法；
 * `ui.<节点>` → 节点名；`ui.<节点>.` → UI 属性。
 */
export function makeScriptCompletionSource(opts: ScriptCompletionOptions = {}): CompletionSource {
  const attrComps = attrCompletions();
  const pluginIds = opts.pluginIds ?? ['phoneLog'];
  const pluginComps: Completion[] = pluginIds.map((id) => ({
    label: id,
    type: 'namespace',
    detail: '插件命名空间',
    info: `plugins.${id}：await plugins.${id}.<方法>(...args)；方法清单取决于插件清单（T6.4 插件桥接入）`,
  }));
  const uiNodeComps: Completion[] = (opts.uiNames ?? []).map((name) => ({
    label: name,
    type: 'variable',
    detail: 'UI 节点',
    info: `ui.${name}：<属性> 直接读写（text/value/checked/visible/items…）`,
  }));

  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    // convert.<member*>
    let m = /\bconvert\.(\w*)$/.exec(before);
    if (m) return { from: ctx.pos - m[1].length, options: CONVERT_COMPLETIONS, validFor: /^\w*$/ };

    // plugins.<id>.<method*>
    m = /\bplugins\.(\w+)\.(\w*)$/.exec(before);
    if (m) return { from: ctx.pos - m[2].length, options: PLUGIN_METHODS[m[1]] ?? [], validFor: /^\w*$/ };
    // plugins.<id*>
    m = /\bplugins\.(\w*)$/.exec(before);
    if (m) return { from: ctx.pos - m[1].length, options: pluginComps, validFor: /^\w*$/ };

    // ui.<节点>.<attr*>
    m = /\bui\.\w+\.(\w*)$/.exec(before);
    if (m) return { from: ctx.pos - m[1].length, options: attrComps, validFor: /^\w*$/ };
    // ui.<节点*>
    m = /\bui\.(\w*)$/.exec(before);
    if (m) {
      if (uiNodeComps.length === 0) return null; // 无资产上下文：不臆造节点名
      return { from: ctx.pos - m[1].length, options: uiNodeComps, validFor: /^\w*$/ };
    }

    // 顶层标识符（前面不是点 / 标识符字符）
    m = /(^|[^\w$.])([A-Za-z_]\w*)$/.exec(before);
    if (m) return { from: ctx.pos - m[2].length, options: GLOBAL_COMPLETIONS, validFor: /^\w*$/ };

    // 显式触发（Ctrl+Space）且无前缀：给出全部全局
    if (ctx.explicit) return { from: ctx.pos, options: GLOBAL_COMPLETIONS };
    return null;
  };
}

/** 缺省补全源（无资产上下文；T3.1 需要节点名 / 插件 id 精化时用 makeScriptCompletionSource） */
export const scriptCompletionSource: CompletionSource = makeScriptCompletionSource();

/**
 * T3.1 接口约定入口：脚本编辑器补全扩展。
 * 把补全源注册进全局 languageData（`autocomplete` 属性）——与编辑器自己的
 * autocompletion()（basicSetup 默认含）自然组合，不覆盖其他补全源。
 */
export function scriptTypesExtension(opts: ScriptCompletionOptions = {}): Extension {
  const source = makeScriptCompletionSource(opts);
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}
