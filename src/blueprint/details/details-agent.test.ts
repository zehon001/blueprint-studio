/**
 * 检视面板 × Agent 能力注入端到端单测（happy-dom 真挂载）
 *
 * 流程 = 编辑器真实路径：openAsset → 后台 loadPluginSpecs（mock /api/plugins +
 * /api/agents/capabilities）→ specs 并入 → 选中 agent.sendMessage 节点 →
 * 渲染 Details → 断言大模型 / 思考强度 / 权限下拉出现 DSH 真实选项。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const dom = new Window({ url: 'http://localhost:5173/' })

function setGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  } catch {
    /* 只读全局：跳过 */
  }
}

for (const key of [
  'window',
  'document',
  'MutationObserver',
  'ResizeObserver',
  'Range',
  'getSelection',
  'Event',
  'CustomEvent',
  'EventTarget',
  'KeyboardEvent',
  'MouseEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLSelectElement',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

/* ---- mock fetch（/api/plugins + /api/agents/capabilities）---- */

const agentManifest = {
  id: 'agent',
  name: 'Agent 会话',
  kind: 'custom',
  description: '',
  nodes: [
    {
      id: 'agent.sendMessage',
      title: '发送 Agent 消息',
      kind: 'action',
      inputs: [
        { id: 'exec', type: 'exec' },
        { id: 'session', type: 'session' },
        { id: 'message', type: 'string', label: '消息内容', options: [] },
        { id: 'waitForCompletion', type: 'bool', label: '等待完成通知', defaultValue: true },
      ],
      params: [
        { id: 'model', label: '大模型', type: 'select', default: '', options: [] },
        { id: 'reasoning', label: '思考强度', type: 'select', default: '', options: [] },
        { id: 'permissions', label: '权限', type: 'select', default: '', options: [] },
        { id: 'workspace', label: '工作区', type: 'directory', default: '' },
        { id: 'reuse', label: '复用已有会话', type: 'bool', default: false },
      ],
      outputs: [{ id: 'exec', type: 'exec' }],
    },
  ],
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response
}

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input)
  if (url.includes('/api/agents/capabilities')) {
    return jsonResponse({
      ok: true,
      platforms: [
        {
          platform: 'dsh',
          connected: true,
          models: [
            { id: 'group/glm-5.3', name: 'GLM-5.3 · routing group' },
            { id: 'group/deepseek41flash', name: 'DeepSeek41Flash · routing group' },
          ],
          reasoningLevels: ['low', 'high', 'max'],
          permissions: ['read-only', 'workspace-write', 'danger-full-access'],
        },
      ],
    }) as unknown as Response
  }
  if (url.includes('/api/plugins')) {
    return jsonResponse({ ok: true, manifests: [agentManifest], warnings: [] }) as unknown as Response
  }
  return jsonResponse({ ok: false, message: `unmocked ${url}` }) as unknown as Response
}) as typeof fetch

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Details } = await import('./Details')
const { useBlueprintStore } = await import('../store/blueprint-store')
const { useWorkspaceStore } = await import('../../shell/workspace-store')
const { resetEditorStore } = await import('../../shell/commands')
const { clearPluginSpecsCache } = await import('../../nodes/dynamic')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}

describe('检视面板 × Agent 能力注入（真挂载）', () => {
  test('选中 agent.sendMessage → 下拉出现 DSH 模型 / 思考强度 / 权限选项', async () => {
    resetEditorStore()
    clearPluginSpecsCache()
    useWorkspaceStore.setState({
      currentProject: { name: 'Agent 最小化测试', path: 'agent-smoke', mainBlueprint: 'logic/main.bp.json', engineVersion: '3.0.0', mtime: null },
    } as never)

    const asset = {
      version: 3,
      name: 'main',
      entry: 'main',
      graphs: {
        main: {
          nodes: [
            {
              id: 'n_send',
              type: 'agent.sendMessage',
              params: { model: '', reasoning: '', permissions: '', workspace: '', reuse: false },
              pinDefaults: { message: '你好', waitForCompletion: true },
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
        },
      },
      variables: [],
      events: [],
      snippets: [],
      layout: {},
    }
    act(() => {
      useBlueprintStore.getState().openAsset(asset as never, 'logic/main.bp.json')
    })
    useBlueprintStore.getState().setSelection({ nodeIds: ['n_send'], edgeIds: [] })

    // 后台插件 specs 合并完成（含能力注入）
    await waitFor(() => {
      const pin = useBlueprintStore
        .getState()
        .specs.get('agent.sendMessage')
        ?.params?.find((p) => p.id === 'model')
      return (pin?.options?.length ?? 0) > 0
    }, 'agent.sendMessage 模型下拉注入')

    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    const root = createRoot(container as unknown as HTMLElement)
    act(() => {
      root.render(createElement(Details, null))
    })

    // 大模型 / 思考强度 / 权限行渲染为下拉，且选项含 DSH 真实目录
    const selects = [...dom.document.querySelectorAll('select')] as unknown as HTMLSelectElement[]
    const allOptions = selects.flatMap((s) => [...s.options].map((o) => o.value))
    assert.ok(allOptions.includes('group/glm-5.3'), `大模型下拉应含 GLM-5.3（实际：${JSON.stringify(allOptions)}）`)
    assert.ok(allOptions.includes('group/deepseek41flash'), '大模型下拉应含 DeepSeek41Flash')
    assert.ok(allOptions.includes('low') && allOptions.includes('max'), '思考强度下拉应含 low / max')
    assert.ok(allOptions.includes('danger-full-access'), '权限下拉应含 danger-full-access')
    assert.match(dom.document.body.textContent ?? '', /GLM-5\.3 · routing group/)
    // 内部设置 / 引脚默认值分组：大模型等在「内部设置」，不再出现在「引脚默认值」
    const text = dom.document.body.textContent ?? ''
    assert.match(text, /内部设置/)
    assert.match(text, /引脚默认值/)
    assert.match(text, /选择目录/, '工作区内部设置带「选择目录」按钮')
    const pinGroup = (text.split('引脚默认值')[1] ?? '').split('内部设置')[0] ?? ''
    assert.doesNotMatch(pinGroup, /大模型/, '大模型不应出现在引脚默认值分组')

    act(() => {
      root.unmount()
      container.remove()
    })
  })
})
