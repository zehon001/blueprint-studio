/**
 * Blueprint Studio v2 —— 片段运行时（T3.7，ADR-007 §4）
 *
 * 解释器执行 script.snippet 节点的 NodeRunFn 实现 + 按资产注入工厂。
 * 零侵入解释器核心：解释器按 spec.inputs 解析输入、按 spec.outputs 校验 exec 出口，
 * 而片段引脚是按实例动态的——因此运行时侧按资产合成片段 spec 并注入 specs 表：
 *
 *   const { asset, specs } = injectSnippetRuntime(ir, editorSpecMap());
 *   const rt = createRuntime(asset, specs, opts);
 *
 *  1. injectSnippetRuntime：克隆 base specs；为执行片段合成 'script.snippet' spec
 *     （pure = false，引脚 = 执行片段引脚并集）、为纯片段合成 'script.snippet.pure' spec
 *     （pure = true，数据引脚并集），并把资产副本中纯片段节点的 type 改写为
 *     'script.snippet.pure'（运行时局部视图；IR 约定不变，编辑 / 往返不受影响）。
 *     混合资产（同图并存执行 / 纯片段）由此各自走解释器的正确执行路径。
 *  2. snippetSnippetRun：以片段引脚 id + T3.2 内建全局（createScriptGlobals 的
 *     ui/vars/emit/onEvent/plugins/print/convert/format/delay）为形参，new Function
 *     严格模式 + async 箭头包裹执行片段代码（无条件支持 await）；this 绑定 vars
 *     变量代理（this.X / vars.X 读写资产变量）。出脚取值：return 对象属性优先，
 *     否则取同名参数终值（裸赋值出脚）；return 非对象值映射到 'result' 出脚。
 *
 * 已知边界（ADR-007 §4）：解释器执行路径暂只支持 lang: 'ts' 片段；引脚 id 须为合法
 * 标识符且不得与环境全局重名（违规抛中文错误）。
 */
import type {
  IRAsset,
  IRGraph,
  IRNode,
  IRSnippet,
  IRSnippetPin,
  NodeRunFn,
  NodeSpec,
} from '../ir/types';
import { createScriptGlobals } from './api/ts';
import {
  SNIPPET_PURE_TYPE,
  RUNTIME_RESERVED_NAMES,
  snippetExecOut,
  snippetHasExecIn,
  snippetIsPure,
  snippetPinIssue,
} from './snippet';

/** injectSnippetRuntime 结果：类型重写后的资产副本 + 注入片段 spec 的 specs 表 */
export interface SnippetRuntimeInjection {
  /** 资产副本（纯片段节点 type 改写为 script.snippet.pure；其余字段深拷贝不变） */
  asset: IRAsset;
  /** specs 表（base 克隆 ∪ 片段运行时 spec；无片段资产时与 base 同内容） */
  specs: Map<string, NodeSpec>;
}

/**
 * 按资产注入片段运行时（createRuntime 调用前的装配步骤；不改入参）。
 * 无片段资产原样返回（asset = 原引用，specs = base 克隆）。
 */
export function injectSnippetRuntime(
  asset: IRAsset,
  base: ReadonlyMap<string, NodeSpec>,
): SnippetRuntimeInjection {
  const snippets = asset?.snippets ?? [];
  const hasSnippetNodes = Object.values(asset?.graphs ?? {}).some((g) =>
    (g.nodes ?? []).some((n) => n.type === 'script.snippet'),
  );
  if (snippets.length === 0 && !hasSnippetNodes) {
    return { asset, specs: new Map(base) };
  }

  // 资产副本：纯片段节点改写 type（运行时局部视图；解释器按 pure spec 惰性求值）
  const cloned = JSON.parse(JSON.stringify(asset)) as IRAsset;
  const snipById = new Map<string, IRSnippet>((cloned.snippets ?? []).map((s) => [s.id, s]));
  const execSnips: IRSnippet[] = [];
  const pureSnips: IRSnippet[] = [];
  for (const s of cloned.snippets ?? []) {
    (snippetIsPure(s.pins) ? pureSnips : execSnips).push(s);
  }
  if (pureSnips.length > 0) {
    for (const g of Object.values(cloned.graphs) as IRGraph[]) {
      for (const n of g.nodes as IRNode[]) {
        const id = n.params?.['snippet'];
        const snip = typeof id === 'string' ? snipById.get(id) : undefined;
        if (n.type === 'script.snippet' && snip && snippetIsPure(snip.pins)) {
          n.type = SNIPPET_PURE_TYPE;
        }
      }
    }
  }

  const specs = new Map(base);
  if (execSnips.length > 0) {
    specs.set('script.snippet', makeSnippetSpec(execSnips, false, snipById));
  }
  if (pureSnips.length > 0) {
    specs.set(SNIPPET_PURE_TYPE, makeSnippetSpec(pureSnips, true, snipById));
  }
  return { asset: cloned, specs };
}

/** 片段运行时 spec（引脚 = 片段组引脚并集；pure 决定解释器走执行链还是惰性求值路径） */
function makeSnippetSpec(
  snippets: readonly IRSnippet[],
  pure: boolean,
  snipById: ReadonlyMap<string, IRSnippet>,
): NodeSpec {
  const union = unionPinsOf(snippets, pure);
  // exec 出脚校验（pickNext）按并集执行片段的声明执行；纯片段只携带数据脚
  const spec: NodeSpec = {
    id: pure ? SNIPPET_PURE_TYPE : 'script.snippet',
    title: '脚本片段',
    category: '脚本片段',
    keywords: ['snippet', '片段', '脚本片段'],
    inputs: union.filter((p) => p.dir === 'in').map((p) => ({ id: p.id, type: p.type })),
    outputs: union.filter((p) => p.dir === 'out').map((p) => ({ id: p.id, type: p.type })),
    params: [{ id: 'snippet', label: '片段 id', type: 'string', default: '' }],
    pure,
    doc: '脚本片段节点（运行时 spec，按资产注入；引脚为该资产片段引脚的并集）。',
    run: makeSnippetRun(snipById),
  };
  return spec;
}

/** 片段组引脚并集（按 dir+id 去重；pure 组只保留数据脚，执行组的 exec 脚保留） */
function unionPinsOf(snippets: readonly IRSnippet[], pure: boolean): IRSnippetPin[] {
  const seen = new Set<string>();
  const out: IRSnippetPin[] = [];
  for (const s of snippets) {
    for (const p of s.pins ?? []) {
      if (!p || typeof p.id !== 'string' || p.id === '') continue;
      if (pure && p.type === 'exec') continue;
      const key = `${p.dir}\u0000${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/* ============================================================
 * 片段执行（new Function 严格模式 + async 箭头包裹）
 * ============================================================ */

/** 编译缓存（键 = IRSnippet 对象；编辑片段产生新对象自动重编译） */
const compileCache = new WeakMap<IRSnippet, { fn: (...args: unknown[]) => Promise<unknown> }>();

/** 环境全局形参序（createScriptGlobals 的返回字段序；位置传参用） */
const ENV_NAMES: readonly string[] = [
  'ui', 'vars', 'emit', 'onEvent', 'plugins', 'print', 'convert', 'format', 'delay',
];

/** 编译片段：返回可执行函数（形参 = in 脚 → out 脚 → __bps_out 收集器 → 环境全局） */
function compileSnippet(snip: IRSnippet): { fn: (...args: unknown[]) => Promise<unknown> } {
  const cached = compileCache.get(snip);
  if (cached) return cached;
  if (snip.lang !== 'ts') {
    throw new Error(`片段「${snip.id}」为 ${snip.lang} 语言，解释器执行路径暂只支持 ts 片段`);
  }
  const inPins: IRSnippetPin[] = [];
  const outPins: IRSnippetPin[] = [];
  for (const p of snip.pins ?? []) {
    if (!p || typeof p.id !== 'string' || p.id === '') continue;
    if (p.type === 'exec') continue;
    const issue = snippetPinIssue(p);
    if (issue) throw new Error(`片段「${snip.id}」：${issue}`);
    (p.dir === 'in' ? inPins : outPins).push(p);
  }
  const paramNames = [
    ...inPins.map((p) => p.id),
    ...outPins.map((p) => p.id),
    '__bps_out',
    ...ENV_NAMES,
  ];
  const duplicate = paramNames.find((name, i) => paramNames.indexOf(name) !== i);
  if (duplicate) {
    throw new Error(
      `片段「${snip.id}」的引脚 id「${duplicate}」重复（同方向引脚 id 必须唯一，且不得与保留名冲突：${[...RUNTIME_RESERVED_NAMES].join('、')}）`,
    );
  }
  // 出脚收集：片段代码以裸名赋值出脚（x = …），箭头闭包读回参数终值；
  // return 提前退出时跳过收集行 → return 对象属性 / 非对象值优先语义成立
  const collect = outPins.map((p) => `__bps_out[${JSON.stringify(p.id)}] = ${p.id};`).join('\n');
  const body = `"use strict";\nreturn (async () => {\n${snip.code}\n;\n${collect}\n})();`;
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new Function(...paramNames, body) as (...args: unknown[]) => Promise<unknown>;
  } catch (err) {
    throw new Error(
      `片段「${snip.id}」编译失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const compiled = { fn };
  compileCache.set(snip, compiled);
  return compiled;
}

/**
 * 片段执行 NodeRunFn 工厂（执行 / 纯片段共用；snipById 来自注入时的资产副本）。
 * 输入：解释器按 spec.inputs 解析的引脚值（inputs[inPin.id]）。
 * 输出：out 脚值（return 对象属性优先，否则同名参数终值）+ exec 出口。
 */
export function makeSnippetRun(snipById: ReadonlyMap<string, IRSnippet>): NodeRunFn {
  return async (ctx, inputs) => {
    const snipId = typeof ctx.params?.snippet === 'string' ? (ctx.params.snippet as string) : '';
    const snip = snipById.get(snipId);
    if (!snip) {
      throw new Error(
        `片段节点「${ctx.nodeId}」引用的片段「${snipId || '(空)'}」不在资产 snippets 中（双击节点填写源码与引脚）`,
      );
    }
    const { fn } = compileSnippet(snip);
    const inPins = (snip.pins ?? []).filter(
      (p) => p && p.dir === 'in' && p.type !== 'exec' && typeof p.id === 'string',
    );
    const outPins = (snip.pins ?? []).filter(
      (p) => p && p.dir === 'out' && p.type !== 'exec' && typeof p.id === 'string',
    );
    // 环境全局：T3.2 内建 API（ui 两级 Proxy / vars 变量代理 / 事件 / 打印 / 延时等）
    const env = createScriptGlobals({
      ui: ctx.ui,
      getVar: ctx.getVar,
      setVar: ctx.setVar,
      emit: ctx.emit,
      print: ctx.print,
      delay: ctx.delay,
      // CLI 桥（T6.4）：脚本 plugins.* 与插件节点共用的调用通道（失败以 ok:false resolve）
      callPlugin: ctx.callPlugin
        ? (pluginId, method, args) => ctx.callPlugin!(pluginId, method, args as unknown[])
        : undefined,
    });
    const outBox: Record<string, unknown> = {};
    const args: unknown[] = [
      ...inPins.map((p) => inputs[p.id]),
      ...outPins.map(() => undefined),
      outBox,
      env.ui,
      env.vars,
      env.emit,
      env.onEvent,
      env.plugins,
      env.print,
      env.convert,
      env.format,
      env.delay,
    ];
    let returned: unknown;
    try {
      // this = vars 变量代理：片段内 this.X / vars.X 读写资产变量（严格模式下生效）
      returned = await fn.apply(env.vars, args);
    } catch (err) {
      throw new Error(
        `片段「${snipId}」执行失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const returnedObj =
      returned !== null && typeof returned === 'object' ? (returned as Record<string, unknown>) : null;
    const outputs: Record<string, unknown> = {};
    for (const p of outPins) {
      if (returnedObj && Object.prototype.hasOwnProperty.call(returnedObj, p.id)) {
        outputs[p.id] = returnedObj[p.id];
        continue;
      }
      outputs[p.id] = outBox[p.id];
    }
    // return 非对象值 → 'result' 出脚（与引脚推导的 return 规则一致）
    if (returned !== undefined && returned !== null && returnedObj === null) {
      if (outPins.some((p) => p.id === 'result')) outputs['result'] = returned;
    }
    if (!snippetHasExecIn(snip.pins)) return { outputs };
    const execOut = snippetExecOut(snip.pins);
    return execOut ? { next: execOut.id, outputs } : { outputs };
  };
}
