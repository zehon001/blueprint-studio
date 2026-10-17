/**
 * Blueprint Studio v2 —— 脚本内建全局运行时实现（T3.2 · PLAN §9.1/§9.2）
 *
 * createScriptGlobals(opts) 按 ScriptGlobalsOptions 构造脚本沙箱执行环境
 * （T3.3 转译执行链用它接线 RuntimeHandle / 绑定 UiHandle；脚本全局与 types.d.ts
 * 的 declare global 逐字段一致，共 9 项）。
 *
 * 语义对齐约定（复用优先，不重写节点逻辑）：
 *  - convert / format：直接调用 src/nodes/convert.ts、src/nodes/string.ts 的节点
 *    run（单源真源），以最小 NodeRunContext 假上下文求值——语义与节点逐字节一致；
 *  - emit 参数规范化：与 src/nodes/events.ts event.send 的 normalizeArgs 语义一致
 *    （对象按名展开 / 数组 → { args } / 单值 → { value }）；多参数走引擎位置式
 *    arg0~argN（解释器事件参数占位脚命名，见 src/runtime/interpreter/interpreter.ts）；
 *  - ui：两级 Proxy（一级 = 节点名 → 节点代理；二级 = 属性读写直通 UiHandle）。
 *    ADR-005 降级纪律：未绑定 UI / 节点缺失时返回安全空对象 + print 提示一次，不抛错；
 *  - vars：Proxy 读 getVar / 写 setVar；Object.keys 列出「声明变量（listVars）∪
 *    本实例写入过的变量」；
 *  - plugins：两级 Proxy → opts.callPlugin(pluginId, method, args)（T6.4 接 CLI 桥；
 *    未接入时调用抛「插件桥未接入」）。
 */
import type { NodeRunContext, NodeRunResult, NodeSpec, UiHandle } from '@/ir/types';
import {
  androidLogParse as androidLogParseNode,
  jsonParse as jsonParseNode,
  jsonStringify as jsonStringifyNode,
  parseIntNode,
  timeFormat as timeFormatNode,
  toBool as toBoolNode,
  toNumber as toNumberNode,
  toStringNode,
} from '@/nodes/convert';
import { format as formatNode } from '@/nodes/string';
import { uiNodeSchemas } from '@/ui-editor/schema';
import type {
  ConvertApi,
  LogRow,
  PluginNamespace,
  PluginsAccessor,
  ScriptGlobals,
  UIAccessor,
  UINodeAttrs,
  VarsAccessor,
} from './types';

/* ============================================================
 * 0. 选项与共享常量
 * ============================================================ */

/** createScriptGlobals 的构造选项（T3.3 沙箱按 RuntimeHandle / UiHandle 接线） */
export interface ScriptGlobalsOptions {
  /** UI 访问器（ADR-005 UiHandle；缺省时 ui.* 降级为安全空对象 + print 提示） */
  ui?: UiHandle;
  /** 读资产变量（必传；未声明变量返回 undefined） */
  getVar(name: string): unknown;
  /** 写资产变量（必传） */
  setVar(name: string, value: unknown): void;
  /** 发送事件（必传；params 语义与 NodeRunContext.emit / RuntimeHandle.emit 一致） */
  emit(event: string, params?: Record<string, unknown>): void;
  /** 打印到运行窗口控制台（必传；print 旁路，不入事件队列） */
  print(...parts: unknown[]): void;
  /** 异步延时（必传；不阻塞其他事件队列，运行中止时以 AbortError reject） */
  delay(ms: number): Promise<void>;
  /** 插件桥（T6.4 接 CLI 桥；未提供时 plugins.<id>.<method>() 抛「插件桥未接入」） */
  callPlugin?(pluginId: string, method: string, args: unknown[]): Promise<unknown>;
  /** 读项目内文件文本（system.readFile 同语义；缺省时 readFile 降级 print 提示返回空串） */
  readProjectFile?(path: string): Promise<string>;
  /** 事件监听注册（缺省时 onEvent print 提示并忽略） */
  onEventRegister?(name: string, handler: (args: unknown) => void): void;
  /** 变量名清单（Object.keys(vars) 列出「声明 ∪ 写过」用；未提供时只列写过的名字） */
  listVars?: () => string[];
}

/** 插件桥未接入的统一报错文案（单测断言依据） */
export const PLUGIN_BRIDGE_MISSING = '插件桥未接入：ScriptGlobalsOptions.callPlugin 未提供（T6.4 接 CLI 桥后可用）';

/** 已注册 UI 属性名集合（权威来源：src/ui-editor/schema 的 PropDef.id；公共属性随 commonProps 已含） */
const KNOWN_UI_ATTRS: ReadonlySet<string> = new Set(
  uiNodeSchemas.flatMap((s) => s.props.map((p) => p.id)),
);

/** 已注册 UI 属性名清单（completion.ts 补全与未知属性警告共用同一权威来源） */
export function knownUIAttrNames(): string[] {
  return [...KNOWN_UI_ATTRS];
}

/* ============================================================
 * 1. 纯节点求值桥（convert / format 的单源复用）
 * ============================================================ */

/** 纯节点求值假上下文：convert/format 节点只读 params 与 inputs，不触碰其余能力 */
const PURE_CTX_BASE: NodeRunContext = {
  nodeId: 'script.globals',
  params: {},
  getVar: () => undefined,
  setVar: () => {},
  emit: () => {},
  print: () => {},
  delay: () => Promise.resolve(),
  signal: new AbortController().signal,
};

/**
 * 调用纯节点 run 取全部输出（单源复用节点实现；run 缺失属于库内部错误，抛出暴露）。
 * timeFormat / androidLogParse 的检视器参数（format / levelFilter）经 params 传入。
 * 注：androidLogParse 的输出键是 rows / count（非 value），调用方按引脚名取值。
 */
function runPureOutputs(spec: NodeSpec, inputs: Record<string, unknown>, params?: Record<string, unknown>): Record<string, unknown> {
  if (!spec.run) throw new Error(`[script] 节点 ${spec.id} 未实现 run，无法作为内建 API 复用`);
  const result = spec.run({ ...PURE_CTX_BASE, params: params ?? {} }, inputs) as NodeRunResult;
  return result.outputs;
}

/** 取纯节点 run 的 'value' 输出（单输出转换节点的通用约定） */
function runPureValue(spec: NodeSpec, inputs: Record<string, unknown>, params?: Record<string, unknown>): unknown {
  return runPureOutputs(spec, inputs, params).value;
}

/** convert 全局：逐函数映射到同语义转换节点（注释即节点 id 与输出引脚） */
const convertApi: ConvertApi = {
  toNumber: (value) => runPureValue(toNumberNode, { value }) as number, // convert.toNumber → value
  toString: (value) => runPureValue(toStringNode, { value }) as string, // convert.toString → value
  toBool: (value) => runPureValue(toBoolNode, { value }) as boolean, // convert.toBool → value
  parseInt: (value) => runPureValue(parseIntNode, { value }) as number, // convert.parseInt → value
  jsonParse: (text) => runPureValue(jsonParseNode, { value: text }), // convert.jsonParse → value
  jsonStringify: (value) => runPureValue(jsonStringifyNode, { value }) as string, // convert.jsonStringify → value
  // convert.timeFormat → value（fmt 缺省时交由节点自身的 'MM-DD HH:mm:SS' 兜底）
  timeFormat: (epochMs, fmt) => runPureValue(timeFormatNode, { epoch: epochMs }, { format: fmt ?? '' }) as string,
  // convert.androidLogParse → rows（节点 LogRow 与本模块 LogRow 同构；levelFilter 缺省 = 不过滤）
  androidLogParse: (lines, levelFilter) =>
    runPureOutputs(androidLogParseNode, { lines }, { levelFilter: levelFilter ?? '' }).rows as LogRow[],
};

/* ============================================================
 * 2. 内部小工具
 * ============================================================ */

/** 去重打印（同一 key 只提示一次，避免刷屏；print 缺失时静默） */
function makeWarnOnce(print: (...parts: unknown[]) => void): (key: string, message: string) => void {
  const warned = new Set<string>();
  return (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    print(message);
  };
}

/**
 * emit 参数规范化——与 src/nodes/events.ts event.send 的 normalizeArgs 语义一致：
 * 对象按名展开（浅拷贝）/ 数组打包 { args } / 单值打包 { value } / 空值 → {}。
 */
function normalizeEmitArgs(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object' && !Array.isArray(v)) {
    return { ...(v as Record<string, unknown>) };
  }
  if (Array.isArray(v)) return { args: v };
  return { value: v };
}

/** 多参数位置式打包：引擎事件参数占位脚命名 arg0~argN（见解释器事件注入约定） */
function positionalEmitArgs(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  args.forEach((v, i) => {
    out[`arg${i}`] = v;
  });
  return out;
}

/* ============================================================
 * 3. ui 访问器（两级 Proxy）
 * ============================================================ */

/** 一级代理保留字（同名节点将被遮蔽；文档已注明用 find('find') 访问此类节点） */
const UI_RESERVED = ['find', 'read', 'write'] as const;

/** 构造 ui 全局：属性式访问 + find/read/write 通用方法（详见 types.d.ts UIAccessor 文档） */
function makeUIAccessor(opts: ScriptGlobalsOptions): UIAccessor {
  const warnOnce = makeWarnOnce(opts.print);
  const hasUI = !!opts.ui;
  const handle: UiHandle = opts.ui ?? { find: () => null, read: () => undefined, write: () => {} };
  const nodeProxies = new Map<string, UINodeAttrs>();

  /** 二级代理：属性读写直通 UiHandle；未知属性提示一次（仍透传） */
  const nodeProxyFor = (name: string, exists: boolean): UINodeAttrs => {
    const cached = nodeProxies.get(name);
    if (cached) return cached;
    const proxy = new Proxy({} as UINodeAttrs, {
      get(_t, attr) {
        if (typeof attr === 'symbol') return undefined;
        if (!exists) return undefined;
        if (!KNOWN_UI_ATTRS.has(attr)) {
          warnOnce(
            `attr:${name}.${attr}`,
            `[script] ui.${name}.${attr} 不在已注册 UI 属性清单（src/ui-editor/schema PropDef）内，仍按原样透传读写`,
          );
        }
        return handle.read(name, attr);
      },
      set(_t, attr, value) {
        if (typeof attr === 'symbol') return false;
        if (!exists) return true; // 安全空对象：find 失败已警告过一次，写入吞掉不抛错
        if (!KNOWN_UI_ATTRS.has(attr)) {
          warnOnce(
            `attr:${name}.${attr}`,
            `[script] ui.${name}.${attr} 不在已注册 UI 属性清单（src/ui-editor/schema PropDef）内，仍按原样透传读写`,
          );
        }
        handle.write(name, attr, value);
        return true;
      },
    });
    nodeProxies.set(name, proxy);
    return proxy;
  };

  /** 一级访问 ui.<节点名>：先 find 判存在性；失败 → 安全空对象 + 提示一次（ADR-005 降级） */
  const nodeAccessor = (name: string): UINodeAttrs => {
    const found = handle.find(name);
    const exists = found !== null && found !== undefined;
    if (!exists) {
      warnOnce(
        `node:${name}`,
        hasUI
          ? `[script] ui.${name} 未找到（绑定 UI 子树中不存在该名节点），返回安全空对象`
          : `[script] UI 访问器未接入（ScriptGlobalsOptions.ui 未提供），ui.${name} 读写为无操作`,
      );
      return nodeProxyFor(name, false);
    }
    return nodeProxyFor(name, true);
  };

  const api = {
    find(name: string): UINodeAttrs | null {
      const found = handle.find(name);
      if (found === null || found === undefined) return null; // 静默版查找（警告由属性式访问负责）
      return nodeProxyFor(name, true);
    },
    read(name: string, attr: string): unknown {
      return handle.read(name, attr);
    },
    write(name: string, attr: string, value: unknown): void {
      handle.write(name, attr, value);
    },
  };

  return new Proxy(api as unknown as UIAccessor, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if ((UI_RESERVED as readonly string[]).includes(prop)) {
        return api[prop as keyof typeof api];
      }
      return nodeAccessor(prop);
    },
  });
}

/* ============================================================
 * 4. vars 访问器（Proxy）
 * ============================================================ */

/** 构造 vars 全局：读 getVar / 写 setVar；Object.keys 列出「声明 ∪ 写过」的变量名 */
function makeVarsAccessor(opts: ScriptGlobalsOptions): VarsAccessor {
  const written = new Set<string>();
  const declared = () => opts.listVars?.() ?? [];
  const isKnown = (name: string) => written.has(name) || declared().includes(name);
  return new Proxy({} as VarsAccessor, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      return opts.getVar(prop);
    },
    set(_t, prop, value) {
      if (typeof prop === 'symbol') return false;
      written.add(prop);
      opts.setVar(prop, value);
      return true;
    },
    has(_t, prop) {
      return typeof prop === 'string' && isKnown(prop);
    },
    ownKeys() {
      const names = new Set<string>(written);
      for (const n of declared()) names.add(n);
      return [...names];
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop !== 'string' || !isKnown(prop)) return undefined;
      return { enumerable: true, configurable: true, writable: true, value: opts.getVar(prop) };
    },
  });
}

/* ============================================================
 * 5. 事件 / 插件 / 打印 / 延时
 * ============================================================ */

/** emit 全局：转发 opts.emit，参数规范化见 normalizeEmitArgs / positionalEmitArgs */
function makeEmit(opts: ScriptGlobalsOptions): ScriptGlobals['emit'] {
  const warnOnce = makeWarnOnce(opts.print);
  return (name, ...args) => {
    if (!name) {
      warnOnce('emit:empty', '[script] emit 事件名为空，事件未发送');
      return;
    }
    if (args.length === 0) {
      opts.emit(name);
    } else if (args.length === 1) {
      opts.emit(name, normalizeEmitArgs(args[0]));
    } else {
      opts.emit(name, positionalEmitArgs(args));
    }
  };
}

/** onEvent 全局：转发 opts.onEventRegister；未接入时 print 提示并忽略（不抛错） */
function makeOnEvent(opts: ScriptGlobalsOptions): ScriptGlobals['onEvent'] {
  const warnOnce = makeWarnOnce(opts.print);
  return (name, handler) => {
    if (!opts.onEventRegister) {
      warnOnce('onEventRegister', '[script] onEventRegister 未接入（ScriptGlobalsOptions.onEventRegister 未提供），事件监听未注册');
      return;
    }
    opts.onEventRegister(name, handler);
  };
}

/** plugins 全局：一级 = 插件 id → 命名空间代理；二级 = 方法 → callPlugin 透传（async，无桥抛错） */
function makePluginsAccessor(opts: ScriptGlobalsOptions): PluginsAccessor {
  const namespaces = new Map<string, PluginNamespace>();
  return new Proxy({} as PluginsAccessor, {
    get(_t, pluginId) {
      if (typeof pluginId === 'symbol') return undefined;
      let ns = namespaces.get(pluginId);
      if (!ns) {
        ns = new Proxy({} as PluginNamespace, {
          get(_t2, method) {
            if (typeof method === 'symbol') return undefined;
            return async (...args: unknown[]) => {
              if (!opts.callPlugin) throw new Error(`[script] ${PLUGIN_BRIDGE_MISSING}`);
              return opts.callPlugin(pluginId, method, args);
            };
          },
        });
        namespaces.set(pluginId, ns);
      }
      return ns;
    },
  });
}

/* ============================================================
 * 6. 工厂入口
 * ============================================================ */

/**
 * 构造脚本内建全局（T3.3 沙箱执行环境的全局注入面）。
 * 返回与 types.d.ts 的 declare global 逐字段一致的 9 项：
 * { ui, vars, emit, onEvent, plugins, print, convert, format, delay }。
 */
export function createScriptGlobals(opts: ScriptGlobalsOptions): ScriptGlobals {
  // print 容错：内部降级提示依赖它，缺失时静默（避免警告路径二次抛错）
  const out = typeof opts.print === 'function' ? opts.print : () => {};
  const safeOpts: ScriptGlobalsOptions = { ...opts, print: out };
  return {
    ui: makeUIAccessor(safeOpts),
    vars: makeVarsAccessor(safeOpts),
    emit: makeEmit(safeOpts),
    onEvent: makeOnEvent(safeOpts),
    plugins: makePluginsAccessor(safeOpts),
    print: (...parts: unknown[]) => safeOpts.print(...parts),
    convert: convertApi,
    format: (template: string, ...args: unknown[]): string =>
      // string.format 节点同语义：{0} {1}… 占位符，缺参替换为空串（多引脚聚合 = args 数组）→ value
      runPureValue(formatNode, { template, args }) as string,
    delay: (ms: number) => safeOpts.delay(ms),
    // system.readFile 同语义：读项目内文件文本；钩子缺失降级提示（返回空串不抛错）
    readFile: async (path: string): Promise<string> => {
      if (!safeOpts.readProjectFile) {
        safeOpts.print('[readFile] 运行上下文未提供文件钩子，已忽略');
        return '';
      }
      try {
        return await safeOpts.readProjectFile(path);
      } catch (err) {
        safeOpts.print(`[readFile] 读取失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
        return '';
      }
    },
  };
}
