/**
 * Blueprint Studio v2 —— 脚本内建全局单测（T3.2，node:test）
 *
 * 覆盖：ui 两级 Proxy（属性式读写直通 UiHandle / 未知节点安全空对象提示一次 /
 * 未知属性提示一次 / find-read-write 直通）、vars Proxy（读 / 写 / Object.keys 声明∪写过）、
 * emit/onEvent 转发与参数规范化（对齐 event.send 节点）、plugins 双态（无桥报
 * 「插件桥未接入」/ 有桥参数透传）、convert/format/delay 语义抽样（复用节点 run 的
 * 对齐性）、types.d.ts 完整性（9 全局 + JSDoc 存在）、completion（全局名 / 成员 /
 * 扩展注册 languageData 补全源）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { createScriptGlobals, PLUGIN_BRIDGE_MISSING, type ScriptGlobalsOptions } from './ts';
import { makeScriptCompletionSource, scriptCompletionSource, scriptTypesExtension } from './completion';

/* ============================================================
 * 测试工具：录制器与全局名清单
 * ============================================================ */

interface Recorder {
  writes: { name: string; attr: string; value: unknown }[];
  reads: { name: string; attr: string }[];
  prints: string[];
  emitted: { event: string; params?: Record<string, unknown> }[];
  registered: { name: string; handler: (args: unknown) => void }[];
  pluginCalls: { pluginId: string; method: string; args: unknown[] }[];
  varStore: Map<string, unknown>;
  delays: number[];
}

/** 选项录制器：ui/getVar/setVar/emit/print/delay 全量记录；callPlugin 等经 extra 覆盖/去除 */
function makeRecorder(
  nodes: Record<string, Record<string, unknown>> = {},
  extra: Partial<ScriptGlobalsOptions> = {},
): { rec: Recorder; opts: ScriptGlobalsOptions } {
  const rec: Recorder = {
    writes: [],
    reads: [],
    prints: [],
    emitted: [],
    registered: [],
    pluginCalls: [],
    varStore: new Map(),
    delays: [],
  };
  const opts: ScriptGlobalsOptions = {
    ui: {
      find: (name) => (name in nodes ? { name } : null),
      read: (name, attr) => {
        rec.reads.push({ name, attr });
        return nodes[name]?.[attr];
      },
      write: (name, attr, value) => {
        rec.writes.push({ name, attr, value });
      },
    },
    getVar: (name) => rec.varStore.get(name),
    setVar: (name, value) => {
      rec.varStore.set(name, value);
    },
    emit: (event, params) => {
      rec.emitted.push({ event, params });
    },
    print: (...parts) => {
      rec.prints.push(parts.map((p) => String(p)).join(' '));
    },
    delay: (ms) => {
      rec.delays.push(ms);
      return Promise.resolve();
    },
    callPlugin: async (pluginId, method, args) => {
      rec.pluginCalls.push({ pluginId, method, args });
      return 'ok';
    },
    onEventRegister: (name, handler) => {
      rec.registered.push({ name, handler });
    },
    listVars: () => ['declaredA', 'declaredB'],
    ...extra,
  };
  return { rec, opts };
}

/** 内建全局清单（types.d.ts declare global 与 ScriptGlobals 的 9 项） */
const GLOBAL_NAMES = ['ui', 'vars', 'emit', 'onEvent', 'plugins', 'print', 'convert', 'format', 'delay'] as const;

/* ============================================================
 * 1. ui 两级 Proxy
 * ============================================================ */

test('ui 代理：属性式读写直通 UiHandle（ui.list.items = rows / ui.title.text）', () => {
  const { rec, opts } = makeRecorder({ list: {}, title: { text: '旧' } });
  const g = createScriptGlobals(opts);

  g.ui.list.items = [{ level: 'INFO', message: '就绪' }];
  assert.deepEqual(rec.writes[0], { name: 'list', attr: 'items', value: [{ level: 'INFO', message: '就绪' }] });

  g.ui.title.text = '日志分析';
  assert.deepEqual(rec.writes[1], { name: 'title', attr: 'text', value: '日志分析' });

  assert.equal(g.ui.title.text, '旧'); // 读 → handle.read('title','text')
  assert.ok(rec.reads.some((r) => r.name === 'title' && r.attr === 'text'));
});

test('ui 代理：find/read/write 通用方法直通；find 未命中返回 null', () => {
  const { rec, opts } = makeRecorder({ title: { text: '旧' } });
  const g = createScriptGlobals(opts);

  assert.ok(g.ui.find('title') !== null);
  assert.equal(g.ui.find('missing'), null);

  // 通用 read / write 直通
  assert.equal(g.ui.read('title', 'text'), '旧');
  g.ui.write('title', 'text', '新');
  assert.deepEqual(rec.writes.at(-1), { name: 'title', attr: 'text', value: '新' });
  assert.ok(rec.reads.some((r) => r.name === 'title' && r.attr === 'text'));
});

test('ui 代理：未知节点 → 安全空对象（读 undefined / 写吞掉）+ print 提示恰好一次', () => {
  const { rec, opts } = makeRecorder({ list: {} });
  const g = createScriptGlobals(opts);

  const ghost = g.ui.ghost;
  assert.equal(ghost.text, undefined); // 安全空对象：读 undefined
  ghost.anything = 1; // 写被吞，不抛错
  g.ui.ghost.other = 2; // 再次访问不重复提示
  assert.equal(rec.prints.filter((p) => p.includes('ghost')).length, 1);
});

test('ui 代理：未知属性 → print 提示（仍按原样透传读写）', () => {
  const { rec, opts } = makeRecorder({ list: {} });
  const g = createScriptGlobals(opts);

  const v = g.ui.list.notARealAttr;
  assert.equal(v, undefined);
  g.ui.list.notARealAttr = 1; // 同 key 只提示一次
  assert.equal(rec.prints.filter((p) => p.includes('notARealAttr')).length, 1);
  assert.deepEqual(rec.writes.at(-1), { name: 'list', attr: 'notARealAttr', value: 1 });
});

test('ui 代理：未提供 opts.ui（ADR-005 降级）→ 读写无操作 + print 提示一次，不抛错', () => {
  const bare = makeRecorder({}, { ui: undefined });
  const g = createScriptGlobals(bare.opts);

  assert.equal(g.ui.title.text, undefined); // 读 undefined
  g.ui.title.text = 'x'; // 写吞掉，不抛错
  assert.equal(bare.rec.writes.length, 0);
  assert.equal(bare.rec.prints.filter((p) => p.includes('title')).length, 1);
  assert.ok(bare.rec.prints[0].includes('UI 访问器未接入'));
  assert.equal(g.ui.find('title'), null); // find 静默返回 null
});

test('createScriptGlobals：返回值恰为 10 个内建全局', () => {
  const { opts } = makeRecorder();
  const g = createScriptGlobals(opts);
  assert.deepEqual(
    Object.keys(g).sort(),
    ['convert', 'delay', 'emit', 'format', 'onEvent', 'plugins', 'print', 'readFile', 'ui', 'vars'],
  );
});

/* ============================================================
 * 2. vars Proxy
 * ============================================================ */

test('vars 代理：读 getVar / 写 setVar / Object.keys 列出「声明 ∪ 写过」', () => {
  const { rec, opts } = makeRecorder();
  const g = createScriptGlobals(opts);

  g.vars.count = 3;
  assert.equal(rec.varStore.get('count'), 3);
  assert.equal(g.vars.count, 3);
  assert.ok('count' in g.vars);
  assert.equal(g.vars.declaredA, undefined); // 声明变量（listVars）可枚举、未赋值读 undefined

  const keys = Object.keys(g.vars);
  assert.ok(keys.includes('count'));
  assert.ok(keys.includes('declaredA'));
  assert.ok(keys.includes('declaredB'));
});

/* ============================================================
 * 3. emit / onEvent 转发
 * ============================================================ */

test('emit：转发 opts.emit，参数规范化与 event.send 节点一致', () => {
  const { rec, opts } = makeRecorder();
  const g = createScriptGlobals(opts);

  g.emit('loaded', 5);
  g.emit('loaded', { count: 5, from: 'x' });
  g.emit('loaded', [1, 2]);
  g.emit('ping');
  g.emit('multi', 1, 'a', true);

  assert.deepEqual(rec.emitted, [
    { event: 'loaded', params: { value: 5 } },
    { event: 'loaded', params: { count: 5, from: 'x' } },
    { event: 'loaded', params: { args: [1, 2] } },
    { event: 'ping', params: undefined },
    { event: 'multi', params: { arg0: 1, arg1: 'a', arg2: true } },
  ]);
});

test('onEvent：转发 onEventRegister（同名同引用）；未接入时提示并忽略', () => {
  const { rec, opts } = makeRecorder();
  const g = createScriptGlobals(opts);
  const handler = (args: unknown): void => {
    void args;
  };
  g.onEvent('refresh', handler);
  assert.equal(rec.registered.length, 1);
  assert.equal(rec.registered[0].name, 'refresh');
  assert.equal(rec.registered[0].handler, handler);

  // 未提供 onEventRegister：print 提示、不抛错、不注册
  const bare = makeRecorder({}, { onEventRegister: undefined });
  const g2 = createScriptGlobals(bare.opts);
  g2.onEvent('x', handler);
  assert.ok(bare.rec.prints.some((p) => p.includes('onEventRegister')));
  assert.equal(bare.rec.registered.length, 0);
});

/* ============================================================
 * 4. plugins 双态
 * ============================================================ */

test('plugins：无 callPlugin → 调用抛「插件桥未接入」；有 → 参数透传', async () => {
  const { rec, opts } = makeRecorder();
  const g = createScriptGlobals(opts);

  const result = await g.plugins.phoneLog.read({ mode: 'adb', filter: 'com.demo' });
  assert.equal(result, 'ok');
  assert.deepEqual(rec.pluginCalls, [
    { pluginId: 'phoneLog', method: 'read', args: [{ mode: 'adb', filter: 'com.demo' }] },
  ]);

  // 无桥：rejected promise，文案含「插件桥未接入」
  const bare = makeRecorder({}, { callPlugin: undefined });
  const g2 = createScriptGlobals(bare.opts);
  await assert.rejects(g2.plugins.phoneLog.read({ mode: 'adb' }), /插件桥未接入/);
  assert.match(PLUGIN_BRIDGE_MISSING, /插件桥未接入/);
});

/* ============================================================
 * 5. convert / format / delay 语义抽样（与节点实现对齐）
 * ============================================================ */

test('convert：语义抽样与转换节点一致（失败降级 0 / 空串 / null）', () => {
  const { opts } = makeRecorder();
  const g = createScriptGlobals(opts);

  assert.equal(g.convert.toNumber('abc'), 0);
  assert.equal(g.convert.toNumber('3.5'), 3.5);
  assert.equal(g.convert.toNumber(true), 1);
  assert.equal(g.convert.toString(null), '');
  assert.equal(g.convert.toBool('yes'), true);
  assert.equal(g.convert.toBool(0), false);
  assert.equal(g.convert.parseInt('12abc'), 12);
  assert.equal(g.convert.parseInt('abc'), 0);
  assert.equal(g.convert.jsonParse('{ bad'), null);
  assert.deepEqual(g.convert.jsonParse('{"a":1}'), { a: 1 });
  assert.equal(g.convert.jsonStringify({ a: 1 }), '{\n  "a": 1\n}');
});

test('convert.timeFormat / androidLogParse：与同名节点语义一致', () => {
  const { opts } = makeRecorder();
  const g = createScriptGlobals(opts);

  // timeFormat：令牌 YYYY/MM/DD/HH/mm/SS（mm 为分钟）；缺省 'MM-DD HH:mm:SS'
  const epoch = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(g.convert.timeFormat(epoch), '01-02 03:04:05');
  assert.equal(g.convert.timeFormat(epoch, 'YYYY/MM/DD'), '2026/01/02');

  // androidLogParse：logcat -v time 格式 + 失败行保留 raw、ts=0
  const rows = g.convert.androidLogParse('10-17 08:00:00.000 I/Tag( 123): hello\nbad line');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].level, 'I');
  assert.equal(rows[0].tag, 'Tag');
  assert.equal(rows[0].pid, 123);
  assert.equal(rows[0].msg, 'hello');
  assert.ok(rows[0].ts > 0);
  assert.equal(rows[1].ts, 0);
  assert.equal(rows[1].raw, 'bad line');

  // 级别过滤
  const filtered = g.convert.androidLogParse('10-17 08:00:00.000 I/A(1): x\n10-17 08:00:01.000 E/B(2): y', 'E');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].level, 'E');
});

test('format：{0} {1}… 占位符替换、缺参空串（string.format 节点同语义）', () => {
  const { opts } = makeRecorder();
  const g = createScriptGlobals(opts);
  assert.equal(g.format('共 {0} 行 · {2}', 5, '不占用'), '共 5 行 · ');
  assert.equal(g.format('{0}+{1}', 'a', 'b'), 'a+b');
});

test('delay：转发 opts.delay（ms 透传，async）', async () => {
  const { rec, opts } = makeRecorder();
  const g = createScriptGlobals(opts);
  await g.delay(500);
  assert.deepEqual(rec.delays, [500]);
});

/* ============================================================
 * 6. types.d.ts 完整性（9 全局声明 + JSDoc 存在 + sample 覆盖）
 * ============================================================ */

test('types.d.ts：9 个全局均有声明且带 JSDoc 文档注释', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dts = readFileSync(join(here, 'types.d.ts'), 'utf8');

  const globalIdx = dts.indexOf('declare global');
  assert.ok(globalIdx >= 0, '缺少 declare global 块');
  const block = dts.slice(globalIdx);

  for (const name of GLOBAL_NAMES) {
    const decl = new RegExp(`(?:var|function|const)\\s+${name}\\b`).exec(block);
    assert.ok(decl, `types.d.ts 缺少全局 ${name} 的声明`);
    const before = block.slice(0, decl.index);
    const docStart = before.lastIndexOf('/**');
    assert.ok(docStart >= 0, `全局 ${name} 声明前缺少 JSDoc 起始`);
    const docEnd = before.indexOf('*/', docStart);
    assert.ok(docEnd > docStart, `全局 ${name} 声明前的 JSDoc 未闭合`);
  }
});

test('sample.ts：引用全部 9 个内建全局（typecheck 由 npm run typecheck 证明）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sample = readFileSync(join(here, 'sample.ts'), 'utf8');
  for (const name of GLOBAL_NAMES) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(sample), `sample.ts 未引用全局 ${name}`);
  }
});

/* ============================================================
 * 7. completion（T3.1 咬合）
 * ============================================================ */

/** 构造补全上下文（同步无视图场景，与 CompletionContext 测试用法一致；本源恒同步返回） */
function complete(source: CompletionSource, doc: string, pos = doc.length, explicit = false): CompletionResult | null {
  return source(new CompletionContext(EditorState.create({ doc }), pos, explicit)) as CompletionResult | null;
}

function labels(result: CompletionResult | null): string[] {
  return result?.options.map((o) => o.label) ?? [];
}

test('completion：补全源返回全部 9 个内建全局名（显式触发无前缀亦给出）', () => {
  const labelsEmpty = labels(complete(scriptCompletionSource, '', 0, true));
  for (const name of GLOBAL_NAMES) assert.ok(labelsEmpty.includes(name), `补全缺全局 ${name}`);

  const labelsTyped = labels(complete(scriptCompletionSource, 'const n = pri'));
  for (const name of ['print', 'plugins']) assert.ok(labelsTyped.includes(name), `补全缺全局 ${name}`);
});

test('completion：convert. / plugins. 成员补全（签名在 detail）', () => {
  const cvt = labels(complete(scriptCompletionSource, 'const rows = convert.'));
  for (const fn of ['toNumber', 'toString', 'toBool', 'parseInt', 'jsonParse', 'jsonStringify', 'timeFormat', 'androidLogParse']) {
    assert.ok(cvt.includes(fn), `convert 成员补全缺 ${fn}`);
  }

  const pluginIds = labels(complete(scriptCompletionSource, 'await plugins.'));
  assert.ok(pluginIds.includes('phoneLog'));

  const methods = labels(complete(scriptCompletionSource, 'await plugins.phoneLog.'));
  assert.ok(methods.includes('read'));

  const result = complete(scriptCompletionSource, 'await plugins.phoneLog.');
  assert.match(result?.options[0].detail ?? '', /LogRow/);
});

test('completion：ui.<节点>.<属性> 属性补全来自 schema PropDef 清单', () => {
  const attrs = labels(complete(scriptCompletionSource, 'ui.list.'));
  for (const attr of ['text', 'value', 'checked', 'visible', 'items', 'columns']) {
    assert.ok(attrs.includes(attr), `UI 属性补全缺 ${attr}`);
  }

  // 一级节点名来自 uiNames 注入；未注入时不臆造
  const withNames = makeScriptCompletionSource({ uiNames: ['list', 'title'] });
  assert.deepEqual(labels(complete(withNames, 'ui.')).sort(), ['list', 'title']);
  assert.deepEqual(labels(complete(scriptCompletionSource, 'ui.')), []);
});

test('scriptTypesExtension：注册 languageData 补全源（T3.1 咬合点）', () => {
  const state = EditorState.create({ extensions: [scriptTypesExtension()] });
  const sources = state.languageDataAt<CompletionSource>('autocomplete', 0);
  assert.equal(sources.length, 1);
  assert.equal(typeof sources[0], 'function');

  // 经扩展注册的源可正常产出全局补全（端到端）
  const result = labels(complete(sources[0], '', 0, true));
  for (const name of GLOBAL_NAMES) assert.ok(result.includes(name), `扩展补全缺全局 ${name}`);
});
