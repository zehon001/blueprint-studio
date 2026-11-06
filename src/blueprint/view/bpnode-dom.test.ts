/**
 * BPNode 变量 Set 节点内联值编辑（happy-dom 冒烟）
 *
 * 用户反馈：Set 节点原先只能连线、不能直接填值；本用例锁定：
 *  - 未连线 → 渲染与变量类型匹配的内联编辑框（int → 数字框；any → JSON/文本框）；
 *  - 已连线 → 编辑框消失（与 UE 行为一致）；
 *  - 编辑提交 → onPinDefaultChange（经命令栈写入 pinDefaults）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import type { ComponentType } from 'react';
import type { IRNode, NodeSpec } from '../../ir/types';
import { builtinSpecMap } from '../../nodes';

const dom = new Window({ url: 'http://localhost/' });
function setGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false });
  } catch {
    /* 只读全局跳过 */
  }
}
for (const key of [
  'window',
  'document',
  'Event',
  'CustomEvent',
  'EventTarget',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) setGlobal(key, value);
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ReactFlowProvider } = await import('@xyflow/react');
const { BPNode } = await import('./BPNode');
const BPNodeComp = BPNode as unknown as ComponentType<Record<string, unknown>>;

function mount(element: ReturnType<typeof createElement>): { unmount: () => Promise<void>; container: HTMLElement } {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  act(() => {
    root.render(element);
  });
  return {
    container: container as unknown as HTMLElement,
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
}

function setNumeric(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
}

function setSetNode(
  varType: string,
  connected: boolean,
  calls: unknown[][],
): { node: IRNode; unmount: () => Promise<void> } {
  const node: IRNode = {
    id: 'set1',
    type: 'var.set',
    params: { varName: 'hp' },
    pinDefaults: {},
    position: { x: 0, y: 0 },
  };
  const spec = builtinSpecMap.get('var.set') as NodeSpec;
  const { unmount } = mount(
    createElement(
      ReactFlowProvider,
      null,
      createElement(BPNodeComp, {
        id: node.id,
        selected: false,
        data: {
          node,
          spec,
          graphName: 'main',
          variant: 'var',
          connectedInputs: new Set(connected ? ['value'] : []),
          degradedInputs: [],
          degradedOutputs: [],
          varType,
          onPinDefaultChange: (nodeId: string, pinId: string, value: unknown) => {
            calls.push([nodeId, pinId, value]);
          },
        },
      }),
    ),
  );
  return { node, unmount };
}

test('BPNode var.set：未连线渲染类型化内联编辑框；已连线隐藏', async () => {
  dom.document.body.innerHTML = '';
  const calls: unknown[][] = [];
  const { unmount } = setSetNode('int', false, calls);
  try {
    const input = dom.document.querySelector(
      '.bp-node-var input.bp-pin-default--num',
    ) as unknown as HTMLInputElement;
    assert.ok(input, 'int 变量 → 数字内联编辑框');
    act(() => setNumeric(input, '42'));
    assert.deepEqual(calls.at(-1), ['set1', 'value', 42], '编辑提交 → onPinDefaultChange');
  } finally {
    await unmount();
  }
});

test('BPNode var.set：已连线时输入框消失（UE 行为）', async () => {
  dom.document.body.innerHTML = '';
  const calls: unknown[][] = [];
  const { unmount } = setSetNode('int', true, calls);
  try {
    assert.equal(
      dom.document.querySelector('.bp-node-var input.bp-pin-default'),
      null,
      '连线后不渲染编辑框',
    );
  } finally {
    await unmount();
  }
});

test('BPNode var.set：any 变量 → JSON/文本框，合法 JSON 按值提交', async () => {
  dom.document.body.innerHTML = '';
  const calls: unknown[][] = [];
  const { unmount } = setSetNode('any', false, calls);
  try {
    const input = dom.document.querySelector(
      '.bp-node-var input.bp-pin-default--json',
    ) as unknown as HTMLInputElement;
    assert.ok(input, 'any 变量 → JSON 内联编辑框');
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '{"level":"INFO"}');
      input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
      input.dispatchEvent(
        new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event,
      );
    });
    assert.deepEqual(calls.at(-1), ['set1', 'value', { level: 'INFO' }]);
  } finally {
    await unmount();
  }
});
