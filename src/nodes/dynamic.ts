/**
 * Blueprint Studio v2 —— 插件节点动态注册通道（T6.4 · PLAN §13.1 dynamic.ts / §14.1 节点同权）
 *
 * 职责：插件清单（PluginManifest，T6.1 三源注册表经 GET /api/plugins 下发）→ NodeSpec
 * 转换 + 动态注册 + 运行时 run（经服务端 CLI 桥 POST /api/plugins/invoke，T6.3 契约）。
 * 插件节点与内置节点完全同权（同样有 exec / 数据引脚），但**不混入 builtinSpecMap**
 * ——合并只发生在 store（useBlueprintStore）与运行时（BindingRunner）装配层。
 *
 * 四个入口（对齐任务卡）：
 *  1. pluginSpecsFromManifest(manifest, project?)：单清单 → NodeSpec[]
 *     （id 规范化为 camelCase 前缀 phone-log → 'phoneLog.'、title 加来源角标、
 *      category 恒为 '插件'（头紫，T2.1 已支持）、引脚按 T0.1 ADR 规范化映射）；
 *  2. loadPluginSpecs(project?, fetchImpl?)：fetch 清单 → 转换 → 按节点 id 去重
 *     （服务端已按插件 id 以「项目 > 静态 > 内置」排序下发，先到先得 = 项目级优先）；
 *     结果按 project 记忆化（T6.2 安装/更新后可调 clearPluginSpecsCache 失效）；
 *  3. invokePluginNode(pluginId, nodeId, inputs, ctx, opts?)：节点 run 的执行体——
 *     inputs → args、POST /api/plugins/invoke（或 ctx.callPlugin 桥）、
 *     ok:true → outputs 映射到声明出脚（缺失补默认）、ok:false / 网络失败 / abort →
 *     ctx.print(中文) + 默认输出 + exec 出脚继续（蓝图可跑不崩，与节点库降级策略一致）；
 *  4. configurePluginInvoke / withPluginRunContext：运行装配——前者登记模块级
 *     { projectName, fetchImpl }（BindingRunner 调用），后者把 projectName / callPlugin
 *     合并进插件节点 run 收到的 ctx（ADR-005 附加扩展字段的实际注入点）。
 *
 * event 节点（持续流，如 phoneLog.onLine）：spec 形状照清单声明（无 exec 入、有 exec 出 +
 * 数据出脚）；本期 run 为一次性拉取语义——T6.3 未提供订阅端点时服务端返回 ok:false，
 * run 打印「持续流模式需 T6.5 执行器」并按默认输出继续，不崩（自动触发接线留 T6.5 WS 推送）。
 *
 * 说明：pluginNodePrefix 与 server/plugins/registry.ts 同逻辑（客户端无法 import 服务端
 * node:fs 模块，故按 ADR-004 规则复刻；单源化可在 ADR-004 回写时上移到 src/ir/types.ts）。
 */
import type {
  IRAsset,
  IRValueType,
  NodeRunContext,
  NodeRunFn,
  NodeSpec,
  ParamOption,
  PinSpec,
  PluginManifest,
  PluginNodeSpec,
} from '../ir/types';
import { isArrayType } from '../ir/types';

/* ============================================================
 * 0. 常量与契约
 * ============================================================ */

/** 插件节点分类（恒定；视图层按分类「插件」渲染紫头，右键搜索同组显示） */
export const PLUGIN_CATEGORY = '插件';

/** 清单来源 → 中文角标（与 server/plugins/registry.ts 的 SOURCE_LABEL 一致） */
const PLUGIN_SOURCE_LABEL: Record<NonNullable<PluginManifest['source']>, string> = {
  builtin: '内置',
  project: '项目',
  static: '静态目录',
};

/** 插件 id → 节点 id 前缀（camelCase + '.'；与 server/plugins/registry.ts pluginNodePrefix 同逻辑） */
export function pluginNodePrefix(pluginId: string): string {
  const camel = pluginId.replace(/[-_]+(.)/g, (_, c: string) => c.toUpperCase());
  return `${camel}.`;
}

/** POST /api/plugins/invoke 响应体（T6.3 PM 定案契约；真实执行器 T6.5 落地后 outputs 有值） */
export interface PluginInvokeResponse {
  /** 是否执行成功（本期对未实现执行器的插件返回 ok:false + 中文 message） */
  ok: boolean;
  /** 输出引脚值（键 = 输出 PinSpec.id） */
  outputs?: Record<string, unknown>;
  /** CLI 标准输出（透传展示） */
  stdout?: string;
  /** CLI 标准错误（透传展示） */
  stderr?: string;
  /** 失败 / 提示消息（中文） */
  message?: string;
}

/** 插件调用桥（NodeRunContext.callPlugin / 脚本 ScriptGlobalsOptions.callPlugin 的实现形状） */
export type PluginInvokeBridge = (
  pluginId: string,
  method: string,
  args: Record<string, unknown> | unknown[],
) => Promise<unknown>;

/** 模块级运行装配（configurePluginInvoke 登记的项目名 / fetch 替身 / 可选桥） */
export interface PluginInvokeConfig {
  /** 项目文件夹名（随 invoke 请求体携带；缺省不携带 = 服务端只按内置 + 静态目录处理） */
  projectName?: string;
  /** fetch 替身（测试 / 多窗口注入；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 直接调用桥（提供时优先于 HTTP；NodeRunContext.callPlugin 缺失时的兜底通道） */
  bridge?: PluginInvokeBridge;
}

const moduleConfig: PluginInvokeConfig = {};

/** 登记模块级运行装配（BindingRunner.loadAndStart 调用；幂等覆盖） */
export function configurePluginInvoke(config: PluginInvokeConfig): void {
  if ('projectName' in config) moduleConfig.projectName = config.projectName;
  if ('fetchImpl' in config) moduleConfig.fetchImpl = config.fetchImpl;
  if ('bridge' in config) moduleConfig.bridge = config.bridge;
}

/** 清空模块级运行装配（测试隔离用） */
export function resetPluginInvokeConfig(): void {
  delete moduleConfig.projectName;
  delete moduleConfig.fetchImpl;
  delete moduleConfig.bridge;
}

/* ============================================================
 * 1. 清单 → NodeSpec（引脚规范化 + run 装配）
 * ============================================================ */

/** pluginSpecsFromManifest 可选项 */
export interface PluginSpecsOptions {
  /**
   * 项目文件夹名（烘焙进节点 run 作为 invoke 的 project 兜底：
   * 解析顺序 opts(invoke) > ctx.projectName > 本值 > configurePluginInvoke 装配值）。
   */
  project?: string;
}

/**
 * 清单引脚 → PinSpec（T0.1 ADR 规范化映射）：
 *  - 'file[]' → 'string[]'（文件路径数组；label 缺失或不含「文件」时补语义标注）；
 *  - 'file'   → 'string'（同上）；
 *  - 'select' → 'string' + options（options 项为字符串时规范化为 { value, label }）；
 *  - 'number' → 'float'（Arch 规范化决策③）；
 *  - 其余类型（含 exec、内置原语、'LogRow[]' 等别名）原样保留。
 */
function pinFromManifest(pin: PinSpec): PinSpec {
  const out: PinSpec = { ...pin };
  const rawOptions = out.options as unknown;
  if (out.type === 'select') {
    out.type = 'string';
  } else if (out.type === 'number') {
    out.type = 'float';
  } else if (out.type === 'file[]') {
    out.type = 'string[]';
    if (!out.label) out.label = '文件列表';
    else if (!out.label.includes('文件')) out.label = `${out.label}（文件）`;
  } else if (out.type === 'file') {
    out.type = 'string';
    if (!out.label) out.label = '文件路径';
    else if (!out.label.includes('文件')) out.label = `${out.label}（文件）`;
  }
  // select 型 options 规范化：字符串项 → { value, label }；非法项剔除
  if (Array.isArray(rawOptions)) {
    const options: ParamOption[] = [];
    for (const op of rawOptions) {
      if (typeof op === 'string') options.push({ value: op, label: op });
      else if (
        op &&
        typeof op === 'object' &&
        typeof (op as ParamOption).value === 'string' &&
        typeof (op as ParamOption).label === 'string'
      ) {
        options.push({ value: (op as ParamOption).value, label: (op as ParamOption).label });
      }
    }
    out.options = options;
  }
  return out;
}

/** 清单节点 id → 规范化节点 id：camelCase 插件前缀 + 尾段（兼容字面 `${pluginId}.` 写法） */
function canonicalPluginNodeId(manifest: PluginManifest, node: PluginNodeSpec): string {
  const prefix = pluginNodePrefix(manifest.id);
  const literal = `${manifest.id}.`;
  const id = node.id ?? '';
  for (const head of [prefix, literal]) {
    if (id.startsWith(head) && id.length > head.length) return prefix + id.slice(head.length);
  }
  return prefix + id; // 未带前缀（服务端校验会拦截）：兜底补前缀
}

/** 输出引脚缺省值（abort / ok:false / 输出缺失时用；与 IR 类型零值约定一致） */
function typeDefault(type: IRValueType): unknown {
  if (type === 'string') return '';
  if (type === 'int' || type === 'float') return 0;
  if (type === 'bool') return false;
  if (isArrayType(type)) return [];
  return null; // object / any / 自定义别名
}

/** 按声明输出脚构造全默认输出（引脚自带 defaultValue 时优先） */
function defaultOutputs(pins?: readonly PinSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pin of pins ?? []) {
    if (pin.type === 'exec') continue;
    out[pin.id] = pin.defaultValue !== undefined ? pin.defaultValue : typeDefault(pin.type);
  }
  return out;
}

/** 把服务端 outputs 映射到声明输出脚（缺失脚补默认；未声明脚丢弃；无声明时原样透传） */
function mapOutputs(
  returned: Record<string, unknown> | undefined,
  pins?: readonly PinSpec[],
): Record<string, unknown> {
  if (!pins || pins.length === 0) return { ...(returned ?? {}) };
  const out = defaultOutputs(pins);
  for (const [key, value] of Object.entries(returned ?? {})) {
    if (pins.some((p) => p.id === key && p.type !== 'exec')) out[key] = value;
  }
  return out;
}

/** 节点 run 的装配参数 */
interface PluginRunInfo {
  /** 插件 id（invoke 请求体 plugin 字段） */
  pluginId: string;
  /** 规范化节点 id（invoke 请求体 node 字段） */
  nodeId: string;
  /** 声明输出脚（输出映射 + 默认值填充依据） */
  outputPins: PinSpec[];
  /** 是否持续流事件节点（失败提示文案区分） */
  isEvent: boolean;
  /** project 兜底（pluginSpecsFromManifest 的 project 参数烘焙值） */
  project?: string;
}

/** inputs（解释器按引脚组装，multi 已聚合为数组）→ invoke 请求 args（剔 exec，去 undefined） */
function argsFromInputs(inputs: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (key === 'exec' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 构造插件节点的 NodeRunFn（action / event 通用）：
 * abort（ctx.signal 已中止）→ 直接返回默认输出不发起请求；
 * invoke 成功 → outputs 映射；失败（ok:false / 网络错误）→ ctx.print(中文) + 默认输出，
 * exec 出脚恒给出——蓝图可跑不崩（与节点库「缺句柄降级」策略一致）。
 */
function makePluginNodeRun(info: PluginRunInfo): NodeRunFn {
  const execOutId = info.outputPins.find((p) => p.type === 'exec')?.id;
  return async (ctx, inputs) => {
    const outcome = await invokePluginNode(info.pluginId, info.nodeId, inputs, ctx, {
      outputPins: info.outputPins,
      project: info.project,
      isEvent: info.isEvent,
    });
    // ok:false / abort 的 print 已在 invokePluginNode 内完成；此处只选 exec 出口
    return execOutId ? { next: execOutId, outputs: outcome.outputs } : { outputs: outcome.outputs };
  };
}

/**
 * 单清单 → NodeSpec[]（T6.4 入口 1）。
 * - id：规范化 camelCase 前缀 + 尾段（phone-log 的 'phoneLog.read' 保持，'phone-log.read' 归一）；
 * - title：节点 title + 来源角标（如「读取手机日志（插件·内置）」；无来源标注时不加）；
 * - category：恒为 '插件'（覆盖清单手写分类，保证紫头与搜索同组）；
 * - 引脚：pinFromManifest 规范化；params / doc / keywords 透传（keywords 补插件名 / id / 尾段）；
 * - run：makePluginNodeRun（经服务端 CLI 桥调用；编辑器从不执行 run，仅运行窗口使用）。
 */
export function pluginSpecsFromManifest(
  manifest: PluginManifest,
  options?: PluginSpecsOptions,
): NodeSpec[] {
  const source = manifest.source;
  const badge = source ? `（插件·${PLUGIN_SOURCE_LABEL[source] ?? source}）` : '';
  const isEventOf = (node: PluginNodeSpec): boolean => (node.kind ?? 'action') === 'event';
  return (manifest.nodes ?? []).map((node) => {
    const id = canonicalPluginNodeId(manifest, node);
    const inputs = (node.inputs ?? []).map(pinFromManifest);
    const outputs = (node.outputs ?? []).map(pinFromManifest);
    const keywords: string[] = [];
    for (const k of [...(node.keywords ?? []), manifest.id, manifest.name, id]) {
      if (typeof k === 'string' && k !== '' && !keywords.includes(k)) keywords.push(k);
    }
    const tail = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
    if (tail && !keywords.includes(tail)) keywords.push(tail);
    const docSuffix = `（来源：插件「${manifest.name}」${source ? PLUGIN_SOURCE_LABEL[source] ?? source : ''}，经 CLI 桥 /api/plugins/invoke 调用）`;
    return {
      id,
      title: `${node.title}${badge}`,
      category: PLUGIN_CATEGORY,
      keywords,
      inputs,
      outputs,
      ...(node.params ? { params: node.params } : {}),
      pure: false,
      doc: node.doc ? `${node.doc}${docSuffix}` : `插件「${manifest.name}」封装节点。${docSuffix}`,
      run: makePluginNodeRun({
        pluginId: manifest.id,
        nodeId: id,
        outputPins: outputs,
        isEvent: isEventOf(node),
        project: options?.project,
      }),
    };
  });
}

/* ============================================================
 * 2. 清单加载（fetch /api/plugins → 转换 → 去重）与合并
 * ============================================================ */

/** loadPluginSpecs 结果 */
export interface PluginSpecsLoadResult {
  /** 转换后的插件节点 specs（按节点 id 去重：服务端「项目 > 静态 > 内置」序先到先得） */
  specs: NodeSpec[];
  /** 加载告警（注册表 warnings 透传 + 客户端形状防御 / 网络失败；不抛错） */
  warnings: string[];
}

/** 结果记忆化（键 = project ?? ''；成功与失败都缓存一次进程，clearPluginSpecsCache 可失效） */
const specsCache = new Map<string, PluginSpecsLoadResult>();
/** 进行中的加载（并发 openAsset / loadAndStart 去重，避免同 project 重复 fetch） */
const inflight = new Map<string, Promise<PluginSpecsLoadResult>>();

/** 清空插件 specs 记忆化（T6.2 安装 / 更新完成后调用；测试隔离亦用） */
export function clearPluginSpecsCache(): void {
  specsCache.clear();
  inflight.clear();
}

/** GET /api/plugins 响应体（server/plugins/registry.ts handlePluginsRequest 契约） */
interface PluginsListResponse {
  ok?: boolean;
  manifests?: unknown;
  warnings?: unknown;
  message?: string;
}

/**
 * 加载全部插件节点 specs（T6.4 入口 2）：
 * fetch GET /api/plugins?project=<项目> → 逐清单 pluginSpecsFromManifest →
 * 按节点 id 去重（先到先得；服务端已按 项目 > 静态 > 内置 排序，重复记 warning）。
 * 任何失败（网络 / 响应形状 / 清单形状）→ 计入 warnings 并按空 specs 继续，不抛错。
 */
export async function loadPluginSpecs(
  project?: string,
  fetchImpl?: typeof fetch,
): Promise<PluginSpecsLoadResult> {
  const key = project ?? '';
  const cached = specsCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<PluginSpecsLoadResult> => {
    const warnings: string[] = [];
    const manifests: PluginManifest[] = [];
    try {
      const f = fetchImpl ?? moduleConfig.fetchImpl ?? fetch;
      const url = project
        ? `/api/plugins?project=${encodeURIComponent(project)}`
        : '/api/plugins';
      const res = await f(url);
      const body = (await res.json().catch(() => null)) as PluginsListResponse | null;
      if (!body || body.ok !== true) {
        warnings.push(`插件注册表加载失败：${body?.message ?? `HTTP ${res.status}`}（本次按无插件节点处理）`);
      } else {
        if (Array.isArray(body.warnings)) {
          for (const w of body.warnings) warnings.push(String(w));
        }
        for (const raw of Array.isArray(body.manifests) ? body.manifests : []) {
          if (!raw || typeof raw !== 'object') continue;
          const m = raw as PluginManifest;
          if (typeof m.id !== 'string' || m.id === '' || !Array.isArray(m.nodes)) {
            warnings.push(`插件清单形状异常，已跳过：${typeof m?.id === 'string' ? m.id : '(无 id)'}`);
            continue;
          }
          manifests.push(m);
        }
      }
    } catch (err) {
      warnings.push(
        `插件注册表不可达（已按无插件节点处理）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 转换 + 按节点 id 去重（跨插件 id 的前缀冲突防御；同 id 先到者保留 = 项目级优先）
    const specs: NodeSpec[] = [];
    const seen = new Map<string, string>();
    for (const m of manifests) {
      for (const spec of pluginSpecsFromManifest(m, { project })) {
        const prev = seen.get(spec.id);
        if (prev) {
          warnings.push(`插件节点 id「${spec.id}」重复（${prev} 与 ${m.id}），保留先到者（项目级优先）`);
          continue;
        }
        seen.set(spec.id, m.id);
        specs.push(spec);
      }
    }
    const result: PluginSpecsLoadResult = { specs, warnings };
    specsCache.set(key, result);
    return result;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/**
 * specs 合并（基线 ∪ 插件；base 键冲突时 base 优先——内置 / 编辑器补充 / 片段 spec
 * 保持权威，插件节点不污染内置库）。返回新 Map，不修改入参。
 */
export function mergePluginSpecs(
  base: ReadonlyMap<string, NodeSpec>,
  extras: readonly NodeSpec[],
): Map<string, NodeSpec> {
  const merged = new Map<string, NodeSpec>(base);
  for (const spec of extras) {
    if (!merged.has(spec.id)) merged.set(spec.id, spec);
  }
  return merged;
}

/**
 * 资产是否含 base（已知 specs）之外的节点类型（= 需要插件节点注册）。
 * 运行时据此按需拉取 /api/plugins：无插件节点的蓝图零额外请求；
 * extra 为「非插件但不在 base」的豁免类型（运行窗口传入片段运行时类型
 * script.snippet / script.snippet.pure——片段 spec 按资产另行注入）。
 */
export function needsPluginSpecs(
  asset: IRAsset,
  base: ReadonlyMap<string, NodeSpec>,
  extra?: ReadonlySet<string>,
): boolean {
  for (const graph of Object.values(asset?.graphs ?? {})) {
    for (const node of graph?.nodes ?? []) {
      const type = node?.type;
      if (typeof type !== 'string' || type === '') continue;
      if (!base.has(type) && !extra?.has(type)) return true;
    }
  }
  return false;
}

/* ============================================================
 * 3. 运行装配（ctx 注入）与 CLI 桥调用
 * ============================================================ */

/** withPluginRunContext 可选项（注入插件节点 run 收到的 ctx） */
export interface PluginRunContextExtra {
  /** 注入 ctx.projectName（ADR-005 附加扩展；ctx 已带时以 ctx 为准） */
  projectName?: string;
  /** 注入 ctx.callPlugin（ADR-005 附加扩展；ctx 已带时以 ctx 为准） */
  callPlugin?: PluginInvokeBridge;
}

/**
 * 为插件节点 specs 的 run 包一层 ctx 增强（不修改入参，返回新 spec 数组）：
 * run 收到的 ctx = { ...ctx, projectName, callPlugin }——BindingRunner 借此把
 * project / CLI 桥塞进 ctx（「读 binding.ts 现有 ctx 构造」在解释器侧不可达，
 * 故在 spec 装配层完成等价注入；解释器未来原生注入时以 ctx 自带值为准）。
 */
export function withPluginRunContext(
  specs: readonly NodeSpec[],
  extra: PluginRunContextExtra,
): NodeSpec[] {
  return specs.map((spec) => {
    if (typeof spec.run !== 'function') return spec;
    const run = spec.run;
    const wrapped: NodeRunFn = (ctx, inputs) =>
      run(
        {
          ...ctx,
          projectName: ctx.projectName ?? extra.projectName,
          callPlugin: ctx.callPlugin ?? extra.callPlugin,
        },
        inputs,
      );
    return { ...spec, run: wrapped };
  });
}

/** 规整桥返回值：完整响应（含布尔 ok）原样；纯对象视为 outputs；标量包 { value }；空视为 {} */
function normalizeInvokeResult(value: unknown): PluginInvokeResponse {
  if (value !== null && typeof value === 'object' && typeof (value as PluginInvokeResponse).ok === 'boolean') {
    return value as PluginInvokeResponse;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ok: true, outputs: value as Record<string, unknown> };
  }
  if (value === undefined || value === null) return { ok: true, outputs: {} };
  return { ok: true, outputs: { value } };
}

/** 脚本侧位置参数 → args 对象（单对象展开 / 单标量包 value / 多值位置式 arg0..N） */
function argsFromScriptCall(args: unknown[] | Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args)) return { ...args };
  if (args.length === 0) return {};
  const first = args[0];
  if (args.length === 1 && first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return { ...(first as Record<string, unknown>) };
  }
  if (args.length === 1) return { value: first };
  const out: Record<string, unknown> = {};
  args.forEach((v, i) => {
    out[`arg${i}`] = v;
  });
  return out;
}

/** invokePluginMethod 可选项（缺省回落模块装配与全局 fetch） */
export interface PluginInvokeMethodOptions {
  projectName?: string;
  fetchImpl?: typeof fetch;
  /** 透传给 fetch 的中止信号（ctx.signal） */
  signal?: AbortSignal;
}

/**
 * 调用服务端 CLI 桥（T6.3 契约）：POST /api/plugins/invoke，body
 * { plugin, node, args, project? }。永不 reject：网络 / 非法响应 / abort 一律
 * resolve { ok:false, message:中文 }，由调用方（节点 run / 脚本）统一降级。
 */
export async function invokePluginMethod(
  pluginId: string,
  method: string,
  args: Record<string, unknown> | unknown[],
  options?: PluginInvokeMethodOptions,
): Promise<PluginInvokeResponse> {
  const projectName = options?.projectName ?? moduleConfig.projectName;
  const f = options?.fetchImpl ?? moduleConfig.fetchImpl ?? fetch;
  const body = {
    plugin: pluginId,
    node: method,
    args: argsFromScriptCall(args),
    ...(projectName ? { project: projectName } : {}),
  };
  try {
    const res = await f('/api/plugins/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const parsed = (await res.json().catch(() => null)) as PluginInvokeResponse | null;
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return { ok: false, message: `插件服务响应异常（HTTP ${res.status}）` };
    }
    return parsed;
  } catch (err) {
    return { ok: false, message: `插件服务调用失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** invokePluginNode 可选项 */
export interface PluginInvokeOptions extends PluginInvokeMethodOptions {
  /** 声明输出脚（输出映射 + 默认值填充依据；缺省原样透传服务端 outputs） */
  outputPins?: readonly PinSpec[];
  /** 持续流事件节点（失败提示补「需 T6.5 执行器」说明） */
  isEvent?: boolean;
  /** project 兜底（specs 烘焙值；解析顺序 opts.project > ctx.projectName > 装配值） */
  project?: string;
}

/** invokePluginNode 结果（outputs 已映射到声明出脚；aborted = 未发起请求直接短路） */
export interface PluginInvokeOutcome {
  ok: boolean;
  outputs: Record<string, unknown>;
  message?: string;
  aborted?: boolean;
}

/**
 * 插件节点 run 的执行体（T6.4 入口 3）：
 *  1. ctx.signal 已中止 → 直接返回默认输出（aborted: true，不 print 不发请求）；
 *  2. ctx.callPlugin 可用 → 走桥（响应规整见 normalizeInvokeResult）；
 *     否则 invokePluginMethod（POST /api/plugins/invoke，project 按
 *     opts.project > ctx.projectName > configurePluginInvoke 装配值解析）；
 *  3. ok:true → outputs 映射到声明出脚（缺失补默认）；stdout 非空时 print 透传；
 *  4. ok:false / 网络失败 → ctx.print 中文（事件节点补「持续流需 T6.5 执行器」）+
 *     stderr 透传 + 默认输出，不抛错——exec 链继续（蓝图不崩）。
 */
export async function invokePluginNode(
  pluginId: string,
  nodeId: string,
  inputs: Record<string, unknown> | undefined,
  ctx: Partial<NodeRunContext> | undefined,
  options?: PluginInvokeOptions,
): Promise<PluginInvokeOutcome> {
  const pins = options?.outputPins;
  const defaults = defaultOutputs(pins);
  const signal = ctx?.signal;
  if (signal?.aborted) {
    return { ok: false, aborted: true, outputs: defaults };
  }
  const print = (...parts: unknown[]): void => ctx?.print?.(...parts);

  let response: PluginInvokeResponse;
  if (typeof ctx?.callPlugin === 'function') {
    response = normalizeInvokeResult(await ctx.callPlugin(pluginId, nodeId, argsFromInputs(inputs)));
  } else {
    response = await invokePluginMethod(pluginId, nodeId, argsFromInputs(inputs), {
      projectName: options?.project ?? ctx?.projectName,
      fetchImpl: options?.fetchImpl,
      signal,
    });
  }

  if (!response.ok) {
    const note = options?.isEvent ? '（持续流模式需 T6.5 执行器，本次按一次性拉取降级）' : '';
    print(
      `[插件] ${nodeId} 调用失败：${response.message ?? '插件执行器未实现或不可用'}${note}（已按默认输出继续执行）`,
    );
    if (response.stderr) print(`[插件] ${nodeId} stderr：${response.stderr}`);
    return { ok: false, outputs: defaults, message: response.message };
  }
  if (response.stdout) print(`[插件] ${nodeId} 输出：${response.stdout.replace(/\s+$/, '')}`);
  return { ok: true, outputs: mapOutputs(response.outputs, pins) };
}
