/**
 * 插件事件节点（Agent 会话事件）解释器语义单测
 *
 * 覆盖：event 形状插件节点（无 exec 入、有 exec 出）经 params.eventName 绑定事件
 * （缺省 = 节点 id）；params.sessionVar 指向会话变量时按 sessionId 过滤触发；
 * 通知参数按名注入输出脚（kind / content / sessionId）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IREdge, IRGraph, IRNode, NodeSpec } from '@/ir/types';
import { createRuntime } from './interpreter';

function n(id: string, type: string, params: Record<string, unknown> = {}, pinDefaults: Record<string, unknown> = {}): IRNode {
  return { id, type, params, pinDefaults, position: { x: 0, y: 0 } };
}

function e(id: string, fromNode: string, fromPin: string, toNode: string, toPin: string, kind: 'exec' | 'data' = 'exec'): IREdge {
  return { id, from: { node: fromNode, pin: fromPin }, to: { node: toNode, pin: toPin }, kind };
}

/** agent.sessionEvent 形状的本地 spec（与 plugins-registry/agent.json 声明同构） */
const SESSION_EVENT_SPEC: NodeSpec = {
  id: 'agent.sessionEvent',
  title: '会话事件',
  category: '插件',
  inputs: [],
  outputs: [
    { id: 'exec', type: 'exec' },
    { id: 'kind', type: 'string', label: '通知类型' },
    { id: 'content', type: 'string', label: '内容' },
    { id: 'sessionId', type: 'string', label: '会话ID' },
  ],
  run: () => ({ outputs: {} }),
};

function makeAsset(params: Record<string, unknown>): IRAsset {
  const main: IRGraph = {
    nodes: [n('ev', 'agent.sessionEvent', params), n('p1', 'printStub')],
    edges: [e('x1', 'ev', 'exec', 'p1', 'exec'), e('d1', 'ev', 'content', 'p1', 'value', 'data')],
  };
  return {
    version: 2,
    name: '测试资产',
    entry: 'main',
    graphs: { main },
    variables: [{ name: 'sess', type: 'session' }],
    events: [],
    snippets: [],
    layout: {},
  };
}

const PRINT_SPEC: NodeSpec = {
  id: 'printStub',
  title: '打印',
  category: '测试',
  inputs: [
    { id: 'exec', type: 'exec' },
    { id: 'value', type: 'any', label: '值' },
  ],
  outputs: [{ id: 'exec', type: 'exec' }],
  run: (ctx, inputs) => {
    ctx.print(inputs.value);
    return { next: 'exec', outputs: {} };
  },
};

const SPECS = new Map<string, NodeSpec>([
  ['agent.sessionEvent', SESSION_EVENT_SPEC],
  ['printStub', PRINT_SPEC],
]);

function waitFor(cond: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error(`等待超时：${label}`));
    }, 2000);
  });
}

test('会话事件：sessionVar 过滤——仅匹配会话的通知触发，参数按名注入', async () => {
  const prints: unknown[] = [];
  const rt = createRuntime(makeAsset({ eventName: 'agent.notification', sessionVar: 'sess' }), SPECS, {
    onPrint: (...parts) => prints.push(parts[0]),
    vars: { sess: { platform: 'dsh', sessionId: 's1', title: '' } },
  });
  rt.start();
  rt.emit('agent.notification', { sessionId: 's2', kind: 'message', content: '不该触发' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(prints, [], '其他会话的通知不应触发');
  rt.emit('agent.notification', { sessionId: 's1', kind: 'message', content: '你好' });
  await waitFor(() => prints.length === 1, '本会话通知触发');
  assert.equal(prints[0], '你好', 'content 出脚按名注入');
  rt.stop();
});

test('会话事件：未配置 sessionVar 不过滤；缺省绑定 = 节点 id', async () => {
  const prints: unknown[] = [];
  const rt = createRuntime(makeAsset({}), SPECS, {
    onPrint: (...parts) => prints.push(parts[0]),
  });
  rt.start();
  rt.emit('agent.sessionEvent', { sessionId: 'zz', kind: 'message', content: '任意' });
  await waitFor(() => prints.length === 1, '按节点 id 绑定触发');
  assert.equal(prints[0], '任意');
  rt.stop();
});
