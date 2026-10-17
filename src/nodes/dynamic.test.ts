/**
 * Blueprint Studio v2 —— 插件节点动态注册单测（T6.4 · node:test）
 *
 * 覆盖（任务卡单测清单）：
 *  1. pluginSpecsFromManifest：phone-log 真实清单 → 2 个 NodeSpec
 *     （id 规范化 / 引脚映射 file[]·select·multi / category 插件 / 来源角标 / 头色变体）；
 *  2. 跨源合并去重：同节点 id 取项目级（先到先得）；跨插件前缀冲突告警；
 *  3. invokePluginNode：mock fetch ok:true outputs 映射；ok:false → 默认值 + print + 不抛错；
 *     网络失败 / abort 降级；ctx.callPlugin 桥优先；脚本位置参数归一；
 *  4. event 型节点 spec 形状（无 exec 入、有 exec 出）+ run 一次性拉取降级；
 *  5. specs 并入 store：openAsset 后右键搜索命中插件节点（分类「插件」分组、内置库纯净）。
 *
 * 运行：npx tsx --test src/nodes/dynamic.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IRAsset, NodeRunContext, NodeRunResult, NodeSpec, PinSpec, PluginManifest } from "../ir/types";
import {
  clearPluginSpecsCache,
  configurePluginInvoke,
  invokePluginNode,
  invokePluginMethod,
  loadPluginSpecs,
  mergePluginSpecs,
  needsPluginSpecs,
  pluginNodePrefix,
  pluginSpecsFromManifest,
  resetPluginInvokeConfig,
  withPluginRunContext,
} from './dynamic';
import { builtinSpecMap } from './index';
import { headVariantFor } from '../blueprint/view/model';
import { searchSpecEntries } from '../blueprint/interaction/logic';
import { selectSearchEntries, useBlueprintStore } from '../blueprint/store/blueprint-store';
import { resetEditorStore } from '../shell/commands';
import { editorSpecMap } from '../blueprint/my-blueprint/graph-op-specs';
import { createRuntime } from '../runtime/interpreter';

/** 测试用最小插件节点形状（manifest.nodes 元素的结构子集；category 由转换层统一补「插件」） */
type PluginNodeSpecLike = {
  id: string;
  title: string;
  inputs: PinSpec[];
  outputs: PinSpec[];
};

/* ============================================================
 * Mock 帮助
 * ============================================================ */

/** 构造 NodeRunContext 假上下文（logs 收集 print；controller 供 abort 用例） */
function makeCtx(overrides: Partial<NodeRunContext> = {}): {
  ctx: NodeRunContext;
  logs: string[];
  controller: AbortController;
} {
  const logs: string[] = [];
  const controller = new AbortController();
  const ctx: NodeRunContext = {
    nodeId: 'n_plugin_1',
    params: {},
    getVar: () => undefined,
    setVar: () => {},
    emit: () => {},
    print: (...parts: unknown[]) => logs.push(parts.map((p) => String(p)).join(' ')),
    delay: () => Promise.resolve(),
    signal: controller.signal,
    ...overrides,
  };
  return { ctx, logs, controller };
}

/** fetch 响应替身：记录调用并回放 JSON；init.body 已字符串化便于断言请求体 */
interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(responder: (url: string, init?: RequestInit) => unknown): {
  impl: typeof fetch;
  calls: RecordedCall[];
  bodies: Record<string, unknown>[];
} {
  const calls: RecordedCall[] = [];
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    bodies.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    return { ok: true, status: 200, json: async () => responder(u, init) } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls, bodies };
}

/** 读取真实内置清单 plugins-registry/phone-log.json（T6.1 交付样例） */
function loadRealManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  const file = path.join(process.cwd(), 'plugins-registry', 'phone-log.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PluginManifest;
  return { ...raw, ...overrides };
}

/** 找 spec 输入 / 输出引脚 */
function pinOf(pins: PinSpec[], id: string): PinSpec {
  const pin = pins.find((p) => p.id === id);
  assert.ok(pin, `引脚 ${id} 应存在`);
  return pin;
}

/* ============================================================
 * 1. pluginSpecsFromManifest（真实清单）
 * ============================================================ */

describe('pluginSpecsFromManifest：phone-log 真实清单 → NodeSpec[]', () => {
  test('phone-log 清单转出 2 个节点：id 规范化 + 分类插件 + 来源角标 + 头色变体', () => {
    const manifest = loadRealManifest({ source: 'builtin' });
    const specs = pluginSpecsFromManifest(manifest);
    assert.equal(specs.length, 2);
    const [read, onLine] = specs;

    // id：manifest 已带 camelCase 前缀 → 原样；category 恒为「插件」；title 带来源角标
    assert.equal(read.id, 'phoneLog.read');
    assert.equal(read.category, '插件');
    assert.ok(read.title.startsWith('读取手机日志'), `title=${read.title}`);
    assert.ok(read.title.includes('内置'), 'title 应含来源角标（内置）');
    assert.equal(headVariantFor(read.id, read), 'plugin', '分类「插件」→ 紫头变体');

    assert.equal(onLine.id, 'phoneLog.onLine');
    assert.equal(onLine.category, '插件');
    assert.equal(headVariantFor(onLine.id, onLine), 'plugin');

    // run 已装配（运行窗口经 CLI 桥调用；编辑器只读结构）
    assert.equal(typeof read.run, 'function');
    assert.equal(typeof onLine.run, 'function');
    // keywords 补全：插件 id / 名称 / 节点尾段可搜
    assert.ok(read.keywords?.includes('手机日志'));
    assert.ok(read.keywords?.includes('phone-log'));
    assert.ok(read.keywords?.includes('read'));
  });

  test('引脚映射：select 型 → string+options；file[] → string[]（label 语义标注）；multi 透传', () => {
    const specs = pluginSpecsFromManifest(loadRealManifest());
    const read = specs[0];
    assert.ok(read);

    // exec 入脚显式保留；mode 下拉：string + options {value,label} + 默认值
    assert.equal(pinOf(read.inputs, 'exec').type, 'exec');
    const mode = pinOf(read.inputs, 'mode');
    assert.equal(mode.type, 'string');
    assert.deepEqual(mode.options, [
      { value: 'device', label: '手机读取' },
      { value: 'file', label: '文件读取' },
    ]);
    assert.equal(mode.defaultValue, 'device');

    // file[] → string[]，label 补「文件」语义标注，multi 透传
    const files = pinOf(read.inputs, 'files');
    assert.equal(files.type, 'string[]');
    assert.equal(files.multi, true);
    assert.ok(files.label?.includes('文件'), `label=${files.label}`);
    assert.equal(pinOf(read.inputs, 'packageFilter').optional, true);

    // 输出：exec 出 + LogRow[] 别名原样 + int
    assert.equal(pinOf(read.outputs, 'exec').type, 'exec');
    assert.equal(pinOf(read.outputs, 'rows').type, 'LogRow[]');
    assert.equal(pinOf(read.outputs, 'count').type, 'int');
  });

  test('清单规范化：字面前缀 id 归一 / select+字符串 options / number → float / file 标量', () => {
    // 清单宽松写法（select options 为字符串数组）按 ADR-004 由服务端校验容忍、客户端规范化；
    // 类型上 PluginNodeSpec.options 为 ParamOption[]，故此处整体宽化断言转换层行为
    const manifest = {
      id: 'feishu-cli',
      name: '飞书 CLI',
      kind: 'cli',
      description: '',
      source: 'project',
      nodes: [
        {
          id: 'feishu-cli.send', // 字面插件前缀写法（T6.1 兼容）→ 归一为 camelCase
          title: '发送消息',
          inputs: [
            { id: 'exec', type: 'exec' },
            { id: 'target', type: 'select', options: ['群聊', '私聊'] }, // ADR-004 宽松写法
            { id: 'weight', type: 'number' }, // Arch 规范化③：number → float
            { id: 'attach', type: 'file' }, // 标量文件 → string（label 标注）
          ],
          outputs: [{ id: 'exec', type: 'exec' }, { id: 'messageId', type: 'string' }],
        },
      ],
    } as unknown as PluginManifest;
    const specs = pluginSpecsFromManifest(manifest);
    assert.equal(specs.length, 1);
    const spec = specs[0]!;
    assert.equal(spec.id, 'feishuCli.send', 'pluginNodePrefix(feishu-cli) = feishuCli.');
    assert.equal(pluginNodePrefix('feishu-cli'), 'feishuCli.');
    assert.ok(spec.title.includes('项目'), '来源角标（项目）');

    const target = pinOf(spec.inputs, 'target');
    assert.equal(target.type, 'string');
    assert.deepEqual(target.options, [
      { value: '群聊', label: '群聊' },
      { value: '私聊', label: '私聊' },
    ]);
    assert.equal(pinOf(spec.inputs, 'weight').type, 'float');
    const attach = pinOf(spec.inputs, 'attach');
    assert.equal(attach.type, 'string');
    assert.equal(attach.label, '文件路径');
  });
});

/* ============================================================
 * 2. loadPluginSpecs：加载 + 跨源合并去重
 * ============================================================ */

describe('loadPluginSpecs：清单加载 / 跨源去重 / 记忆化', () => {
  test('合并去重：同插件双源（项目 > 内置）同节点 id 取项目级', async () => {
    clearPluginSpecsCache();
    resetPluginInvokeConfig();
    const projectRead: PluginNodeSpecLike = {
      id: 'phoneLog.read',
      title: '读取手机日志（项目增强版）',
      inputs: [{ id: 'exec', type: 'exec' }],
      outputs: [{ id: 'exec', type: 'exec' }, { id: 'count', type: 'int' }],
    };
    const builtinRead: PluginNodeSpecLike = {
      id: 'phoneLog.read',
      title: '读取手机日志',
      inputs: [{ id: 'exec', type: 'exec' }],
      outputs: [{ id: 'exec', type: 'exec' }, { id: 'rows', type: 'LogRow[]' }],
    };
    // 服务端（T6.1）已按「项目 > 静态 > 内置」排序下发；此处模拟项目级在前（正常与
    // 病理重复两种来源统一走先到先得去重，重复由客户端防御性记 warning）
    const { impl, calls } = mockFetch(() => ({
      ok: true,
      manifests: [
        { id: 'phone-log', name: '手机日志', kind: 'cli', description: '', source: 'project', nodes: [projectRead] },
        { id: 'phone-log', name: '手机日志', kind: 'cli', description: '', source: 'builtin', nodes: [builtinRead] },
      ],
      warnings: [],
    }));
    const { specs, warnings } = await loadPluginSpecs('MyTool', impl);
    assert.equal(specs.length, 1, '同节点 id 去重后仅 1 个');
    assert.equal(specs[0]!.title.includes('项目增强版'), true, '项目级清单先到先得');
    assert.equal(specs[0]!.title.includes('项目'), true, 'title 带项目来源角标');
    assert.equal(warnings.length, 1, '重复同 id 记防御性告警');
    assert.ok(warnings[0]!.includes('phoneLog.read'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, '/api/plugins?project=MyTool');
  });

  test('跨插件 id 前缀冲突：同节点 id 记 warning，保留先到者', async () => {
    clearPluginSpecsCache();
    const node: PluginNodeSpecLike = {
      id: 'phoneLog.read',
      title: '读取',
      inputs: [],
      outputs: [],
    };
    const { impl } = mockFetch(() => ({
      ok: true,
      manifests: [
        { id: 'phone-log', name: 'A', kind: 'cli', description: '', source: 'builtin', nodes: [node] },
        { id: 'phoneLog', name: 'B', kind: 'cli', description: '', source: 'static', nodes: [{ ...node, title: 'B 版' }] },
      ],
      warnings: [],
    }));
    const { specs, warnings } = await loadPluginSpecs('Conflict', impl);
    assert.equal(specs.length, 1, '同节点 id 只保留先到者');
    assert.equal(specs[0]!.title, '读取（插件·内置）');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes('phoneLog.read'));
  });

  test('网络失败：warnings 记中文提示、specs 为空、不抛错；记忆化生效 + clear 失效', async () => {
    clearPluginSpecsCache();
    const broken = (async () => {
      throw new TypeError('Failed to parse URL');
    }) as unknown as typeof fetch;
    const failed = await loadPluginSpecs('Offline', broken);
    assert.equal(failed.specs.length, 0);
    assert.equal(failed.warnings.length, 1);
    assert.ok(failed.warnings[0]!.includes('插件注册表不可达'));

    // 记忆化：同 project 第二次调用不再发请求（缓存命中，结果同引用）
    const again = await loadPluginSpecs('Offline', broken);
    assert.equal(again, failed);
    const viaCache = await loadPluginSpecs('Offline');
    assert.equal(viaCache, failed, 'fetchImpl 缺省时也命中缓存');
    clearPluginSpecsCache();
    const refetched = await loadPluginSpecs('Offline', broken);
    assert.notEqual(refetched, failed, 'clear 后重新加载');
  });
});

/* ============================================================
 * 3. invokePluginNode / 节点 run：CLI 桥调用与降级
 * ============================================================ */

describe('invokePluginNode：ok 映射 / ok:false 降级 / abort / ctx.callPlugin', () => {
  test('ok:true：inputs → args（剔 exec）→ outputs 映射到声明出脚，run 给出 exec 出口', async () => {
    resetPluginInvokeConfig();
    clearPluginSpecsCache();
    const spec = pluginSpecsFromManifest(loadRealManifest())[0]!;
    const { impl, calls, bodies } = mockFetch(() => ({
      ok: true,
      outputs: { rows: [{ raw: '10-01 08:00:00.000 D/TAG(1): hi' }], count: 1 },
      stdout: '3 行',
    }));
    configurePluginInvoke({ projectName: 'MyTool', fetchImpl: impl });
    const { ctx, logs } = makeCtx();

    const result = await spec.run!(ctx, { exec: undefined, mode: 'device', packageFilter: undefined });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, '/api/plugins/invoke');
    const body = bodies[0] as { plugin: string; node: string; args: Record<string, unknown>; project: string };
    assert.equal(body.plugin, 'phone-log');
    assert.equal(body.node, 'phoneLog.read');
    assert.deepEqual(body.args, { mode: 'device' }, 'exec / undefined 引脚不进 args');
    assert.equal(body.project, 'MyTool', 'project 来自运行装配');
    assert.deepEqual(result, {
      next: 'exec',
      outputs: { rows: [{ raw: '10-01 08:00:00.000 D/TAG(1): hi' }], count: 1 },
    });
    assert.ok(logs.join('\n').includes('3 行'), 'stdout 透传 print');
  });

  test('ok:false：中文 print + 输出默认值 + 不抛错 + exec 继续走（蓝图不崩）', async () => {
    resetPluginInvokeConfig();
    const spec = pluginSpecsFromManifest(loadRealManifest())[0]!;
    const { impl } = mockFetch(() => ({ ok: false, message: '插件 phone-log 尚未实现执行器' }));
    configurePluginInvoke({ fetchImpl: impl });
    const { ctx, logs } = makeCtx();

    const result = (await spec.run!(ctx, {})) as NodeRunResult;
    assert.deepEqual(result.outputs, { rows: [], count: 0 }, '缺失出脚按类型默认值');
    assert.equal((result as { next?: string }).next, 'exec', '失败也给出 exec 出口，链继续');
    assert.equal(logs.length, 1);
    assert.ok(logs[0]!.includes('插件 phone-log 尚未实现执行器'));
    assert.ok(logs[0]!.includes('已按默认输出继续执行'));
  });

  test('网络异常：与 ok:false 同路降级（中文错误 + 默认值 + 不抛错）', async () => {
    resetPluginInvokeConfig();
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    configurePluginInvoke({ fetchImpl: impl });
    const { ctx, logs } = makeCtx();
    const outcome = await invokePluginNode('phone-log', 'phoneLog.read', {}, ctx, {
      outputPins: [
        { id: 'exec', type: 'exec' },
        { id: 'count', type: 'int' },
        { id: 'rows', type: 'LogRow[]' },
      ],
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.outputs, { count: 0, rows: [] });
    assert.ok(logs[0]!.includes('插件服务调用失败'));
    assert.ok(logs[0]!.includes('ECONNREFUSED'));
  });

  test('abort：ctx.signal 已中止 → 直接返回默认输出，不发请求不 print', async () => {
    resetPluginInvokeConfig();
    const { impl, calls } = mockFetch(() => ({ ok: true, outputs: { count: 9 } }));
    configurePluginInvoke({ fetchImpl: impl });
    const { ctx, logs, controller } = makeCtx();
    controller.abort();

    const outcome = await invokePluginNode('phone-log', 'phoneLog.read', {}, ctx, {
      outputPins: [
        { id: 'exec', type: 'exec' },
        { id: 'count', type: 'int' },
      ],
    });
    assert.equal(outcome.aborted, true);
    assert.deepEqual(outcome.outputs, { count: 0 });
    assert.equal(calls.length, 0, '已中止不发请求');
    assert.deepEqual(logs, []);
  });

  test('ctx.callPlugin 优先于 HTTP；返回完整响应 / 裸对象均可规整', async () => {
    resetPluginInvokeConfig();
    const { impl, calls } = mockFetch(() => ({ ok: true, outputs: {} }));
    configurePluginInvoke({ fetchImpl: impl });
    const bridgeArgs: Array<{ plugin: string; method: string; args: Record<string, unknown> }> = [];
    const { ctx } = makeCtx({
      callPlugin: async (pluginId, method, args) => {
        bridgeArgs.push({ plugin: pluginId, method, args: args as Record<string, unknown> });
        return { ok: true, outputs: { count: 3 } }; // 完整响应形状
      },
    });
    const outcome = await invokePluginNode('phone-log', 'phoneLog.read', { mode: 'file' }, ctx, {
      outputPins: [
        { id: 'exec', type: 'exec' },
        { id: 'count', type: 'int' },
        { id: 'rows', type: 'LogRow[]' },
      ],
    });
    assert.equal(calls.length, 0, '有桥不走 HTTP');
    assert.deepEqual(bridgeArgs, [{ plugin: 'phone-log', method: 'phoneLog.read', args: { mode: 'file' } }]);
    assert.deepEqual(outcome.outputs, { count: 3, rows: [] });

    // 桥返回裸对象（无 ok 字段）→ 视为 outputs
    const { ctx: ctx2 } = makeCtx({ callPlugin: async () => ({ count: 7 }) });
    const outcome2 = await invokePluginNode('phone-log', 'phoneLog.read', {}, ctx2, {
      outputPins: [
        { id: 'exec', type: 'exec' },
        { id: 'count', type: 'int' },
      ],
    });
    assert.deepEqual(outcome2.outputs, { count: 7 });
    assert.equal(outcome2.ok, true);
  });

  test('withPluginRunContext：projectName / callPlugin 注入 run 收到的 ctx', async () => {
    resetPluginInvokeConfig();
    const spec = pluginSpecsFromManifest(loadRealManifest())[0]!;
    const { impl, calls, bodies } = mockFetch(() => ({ ok: true, outputs: { count: 1 } }));
    configurePluginInvoke({ fetchImpl: impl }); // 不设 projectName → 验证 ctx 注入
    const bridgeCalls: string[] = [];
    const [wrapped] = withPluginRunContext([spec], {
      projectName: 'MyTool',
      callPlugin: async () => {
        bridgeCalls.push('called');
        return { ok: true, outputs: { count: 5 } };
      },
    });
    assert.notEqual(wrapped, spec, '返回新 spec 对象，不改入参');
    const { ctx } = makeCtx();
    const result = (await wrapped.run!(ctx, {})) as NodeRunResult;
    assert.deepEqual(bridgeCalls, ['called'], 'ctx.callPlugin 已注入并被优先使用');
    assert.deepEqual(result.outputs, { rows: [], count: 5 });

    // 无 callPlugin 时走 HTTP，projectName 来自 ctx 注入
    const [wrapped2] = withPluginRunContext([spec], { projectName: 'Ctx 项目' });
    const { ctx: ctx2 } = makeCtx();
    await wrapped2.run!(ctx2, {});
    assert.equal(calls.length, 1);
    assert.equal((bodies[0] as { project?: string }).project, 'Ctx 项目');
  });

  test('invokePluginMethod：脚本位置参数归一（单对象展开 / 标量包 value / 多值位置式）', async () => {
    resetPluginInvokeConfig();
    const { impl, bodies } = mockFetch(() => ({ ok: true, outputs: {} }));
    await invokePluginMethod('phone-log', 'read', [{ mode: 'device' }], { fetchImpl: impl });
    assert.deepEqual((bodies[0] as { args: unknown }).args, { mode: 'device' });
    await invokePluginMethod('phone-log', 'read', ['a', 'b'], { fetchImpl: impl });
    assert.deepEqual((bodies[1] as { args: unknown }).args, { arg0: 'a', arg1: 'b' });
    await invokePluginMethod('phone-log', 'read', [42], { fetchImpl: impl });
    assert.deepEqual((bodies[2] as { args: unknown }).args, { value: 42 });
  });
});

/* ============================================================
 * 4. event 型节点（持续流）spec 形状与降级
 * ============================================================ */

describe('event 型节点：无 exec 入 / 有 exec 出 / run 一次性拉取降级', () => {
  test('phoneLog.onLine spec 形状：inputs 无 exec 入，outputs 有 exec 出 + 数据出脚', () => {
    const spec = pluginSpecsFromManifest(loadRealManifest())[1]!;
    assert.equal(spec.id, 'phoneLog.onLine');
    assert.equal(spec.inputs.length, 0, 'event 节点无 exec 入口');
    const execOut = spec.outputs.find((p) => p.type === 'exec');
    assert.ok(execOut, 'event 节点必须有 exec 出口');
    assert.equal(execOut.id, 'exec');
    assert.equal(pinOf(spec.outputs, 'line').type, 'string');
    assert.equal(spec.pure, false);
  });

  test('event 节点 run：服务端未实现（ok:false）→ 打印 T6.5 提示 + 默认输出 + exec 继续', async () => {
    resetPluginInvokeConfig();
    const spec = pluginSpecsFromManifest(loadRealManifest())[1]!;
    const { impl } = mockFetch(() => ({ ok: false, message: '插件 phone-log 尚未实现执行器' }));
    configurePluginInvoke({ fetchImpl: impl });
    const { ctx, logs } = makeCtx();
    const result = (await spec.run!(ctx, {})) as NodeRunResult;
    assert.deepEqual(result.outputs, { line: '' });
    assert.equal((result as { next?: string }).next, 'exec');
    assert.ok(logs.join('\n').includes('持续流模式需 T6.5 执行器'), `logs=${logs.join(' | ')}`);
  });
});

/* ============================================================
 * 5. mergePluginSpecs（基线 ∪ 插件；内置权威）
 * ============================================================ */

describe('mergePluginSpecs：基线优先，插件只增不改', () => {
  test('base 冲突键保留内置，插件节点追加；不修改入参 Map', () => {
    const base = new Map<string, NodeSpec>(builtinSpecMap);
    const baseSize = base.size;
    const pluginSpec = pluginSpecsFromManifest(loadRealManifest())[0]!;
    const intruder: NodeSpec = { ...pluginSpec, id: 'flow.branch', title: '冒牌分支' };
    const merged = mergePluginSpecs(base, [intruder, pluginSpec]);
    assert.equal(merged.size, baseSize + 1);
    assert.equal(merged.get('flow.branch')!.title, '分支', '内置 flow.branch 不被插件覆盖');
    assert.ok(merged.get('phoneLog.read'), '插件节点已并入');
    assert.equal(base.size, baseSize, '入参 Map 未被修改');
  });
});

/* ============================================================
 * 5.5 运行时按需拉取 + 真解释器经 CLI 桥执行插件节点
 * ============================================================ */

/** 轮询等待条件成立（解释器事件链异步执行） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('运行时接线：needsPluginSpecs 按需拉取 + createRuntime 经 CLI 桥执行', () => {
  test('needsPluginSpecs：未知类型（插件节点）→ true；片段类型豁免；内置类型 → false', () => {
    const base = editorSpecMap();
    const mk = (types: string[]): IRAsset => ({
      version: 2,
      name: 'x',
      entry: 'main',
      graphs: { main: { nodes: types.map((t, i) => ({ id: `n${i}`, type: t, params: {}, pinDefaults: {}, position: { x: 0, y: 0 } })), edges: [] } },
      variables: [],
      events: [],
      snippets: [],
      layout: {},
    });
    assert.equal(needsPluginSpecs(mk(['event.start', 'flow.branch']), base), false, '全内置 → 不拉取');
    assert.equal(needsPluginSpecs(mk(['phoneLog.read']), base), true, '未知类型 → 拉取');
    assert.equal(
      needsPluginSpecs(mk(['script.snippet', 'script.snippet.pure']), base, new Set(['script.snippet', 'script.snippet.pure'])),
      false,
      '片段运行时类型豁免（按资产另行注入）',
    );
  });

  test('端到端：start 事件链 → phoneLog.read 节点 run → POST /api/plugins/invoke（ctx 注入 project）', async () => {
    clearPluginSpecsCache();
    resetPluginInvokeConfig();
    const ir: IRAsset = {
      version: 2,
      name: '插件运行',
      entry: 'main',
      graphs: {
        main: {
          nodes: [
            { id: 's1', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
            { id: 'p1', type: 'phoneLog.read', params: {}, pinDefaults: { mode: 'device' }, position: { x: 200, y: 0 } },
          ],
          edges: [
            { id: 'e1', from: { node: 's1', pin: 'exec' }, to: { node: 'p1', pin: 'exec' }, kind: 'exec' },
          ],
        },
      },
      variables: [],
      events: [],
      snippets: [],
      layout: {},
    };
    const { impl, calls, bodies } = mockFetch((url) => {
      if (String(url).startsWith('/api/plugins') && !String(url).includes('/invoke')) {
        return { ok: true, manifests: [loadRealManifest({ source: 'builtin' })], warnings: [] };
      }
      return { ok: true, outputs: { rows: ['row-1'], count: 1 } };
    });
    configurePluginInvoke({ fetchImpl: impl }); // projectName 不设 → 由 withPluginRunContext 的 ctx 注入提供
    // specs 链（BindingRunner.loadAndStart 同构）：editorSpecMap ∪ withPluginRunContext(插件 specs)
    const base = editorSpecMap();
    const loaded = await loadPluginSpecs('RunDemo', impl);
    const specs = mergePluginSpecs(
      base,
      withPluginRunContext(loaded.specs, {
        projectName: 'RunDemo',
        callPlugin: (pluginId, method, args) => invokePluginMethod(pluginId, method, args, { projectName: 'RunDemo', fetchImpl: impl }),
      }),
    );
    const errors: string[] = [];
    const rt = createRuntime(ir, specs, { onError: (e) => errors.push(e.message) });
    rt.start();
    await waitFor(() => calls.some((c) => c.url === '/api/plugins/invoke'), '插件 invoke 请求');
    await waitFor(() => bodies.length >= 2, 'invoke 响应已回放');
    const invokeBody = bodies[1] as { plugin: string; node: string; args: Record<string, unknown>; project: string };
    assert.equal(invokeBody.plugin, 'phone-log');
    assert.equal(invokeBody.node, 'phoneLog.read');
    assert.deepEqual(invokeBody.args, { mode: 'device', files: [] }, 'pinDefaults 经解释器 inputs → args（multi 无值 = 空数组；undefined 引脚剔除）');
    assert.equal(invokeBody.project, 'RunDemo', 'project 来自 ctx 注入（ADR-005 附加扩展）');
    await waitFor(() => errors.length > 0 || rt.isRunning, '链稳定');
    assert.deepEqual(errors, [], 'ok:true 路径节点不报错');
    rt.stop();
  });
});

/* ============================================================
 * 6. specs 并入 store：右键搜索命中（store 级）
 * ============================================================ */

/** store 测试样例资产（最小主图） */
function sampleAsset(): IRAsset {
  return {
    version: 2,
    name: '主图资产',
    entry: 'main',
    graphs: { main: { nodes: [], edges: [] } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

describe('store 接线：openAsset 异步并入插件 specs → 右键搜索命中', () => {
  test('openAsset 后 specs 含插件节点；搜索「手机日志」命中；builtinSpecMap 保持纯净', async () => {
    clearPluginSpecsCache();
    resetPluginInvokeConfig();
    resetEditorStore();
    const realFetch = globalThis.fetch;
    const { impl } = mockFetch((url) => {
      if (String(url).startsWith('/api/plugins') && !String(url).includes('/invoke')) {
        return {
          ok: true,
          manifests: [loadRealManifest({ source: 'project' })],
          warnings: [],
        };
      }
      return { ok: false, message: `意外请求：${String(url)}` };
    });
    globalThis.fetch = impl;
    try {
      const builtinSizeBefore = builtinSpecMap.size;
      useBlueprintStore.getState().openAsset(sampleAsset(), 'logic/main.bp.json');
      // 等待后台装配（fetch mock 立即 resolve；一个宏任务足够）
      await new Promise((resolve) => setTimeout(resolve, 20));

      const state = useBlueprintStore.getState();
      const pluginSpec = state.specs.get('phoneLog.read');
      assert.ok(pluginSpec, '插件节点已并入 store.specs');
      assert.equal(pluginSpec.category, '插件');
      assert.equal(headVariantFor('phoneLog.read', pluginSpec), 'plugin', '右键列表/画布将渲染紫头');

      // 右键搜索基于 specs 表：命中且分类「插件」
      const hits = searchSpecEntries(selectSearchEntries(state), '手机日志');
      assert.ok(hits.some((e) => e.spec.id === 'phoneLog.read'), '搜索「手机日志」命中插件节点');
      const byPin = searchSpecEntries(selectSearchEntries(state), 'onLine');
      assert.ok(byPin.some((e) => e.spec.id === 'phoneLog.onLine'), '尾段关键词可搜');

      // 内置库保持纯净（合并在 store/runtime 层）
      assert.equal(builtinSpecMap.size, builtinSizeBefore);
      assert.equal(builtinSpecMap.has('phoneLog.read'), false);
    } finally {
      globalThis.fetch = realFetch;
      resetEditorStore();
    }
  });
});
