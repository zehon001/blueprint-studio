/** 人设页 DOM 冒烟：当前角色卡、分节编辑、规范分节、记忆整理按钮。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { PersonDetail } from '@/shared/personnel'

const dom = new Window({ url: 'http://localhost/' })

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
  'Event',
  'CustomEvent',
  'EventTarget',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Node',
  'localStorage',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MemoryTab, NormsTab, RoleCardsTab } = await import('./PersonaTabs')

async function mount(
  node: ReturnType<typeof createElement>,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => {
    root.render(node)
  })
  await act(async () => {})
  return {
    container: container as unknown as HTMLElement,
    unmount: async () => {
      await act(async () => {
        root.unmount()
        container.remove()
      })
    },
  }
}

function samplePerson(): PersonDetail {
  return {
    id: 'p-test',
    name: '测试人员',
    typeId: 'general',
    avatarUrl: '',
    createdAt: 1,
    updatedAt: 1,
    defaultWorkspace: '/tmp/workspace',
    activeWorkspace: '/tmp/workspace',
    roleCardCount: 1,
    memoryCount: 1,
    stats: { runs: 0, completed: 0, failed: 0 },
    run: { status: 'idle' },
    queue: { status: 'idle', total: 0, completed: 0, failed: 0 },
    taskCounts: { total: 0, pending: 0, running: 0, completed: 0, failed: 0, stopped: 0 },
    config: {
      id: 'p-test',
      name: '测试人员',
      typeId: 'general',
      createdAt: 1,
      updatedAt: 1,
      task: '',
      currentCardId: 'card-1',
      parallelism: 1,
      model: { platform: 'dsh', model: '', reasoning: '', permission: '' },
      workspace: {
        dir: '',
        sessionTitle: '',
        deleteSessionAfterRun: false,
        reuseSession: true,
      },
      stats: { runs: 0, completed: 0, failed: 0 },
    },
    cards: [
      {
        id: 'card-1',
        name: '测试角色',
        tags: ['测试'],
        content: '你是测试角色。\n\n【职责】\n负责验证功能。',
      },
      {
        id: 'card-2',
        name: '备用角色',
        tags: [],
        content: '你是备用角色。',
      },
    ],
    norms: '# 工作规范\n\n## 文件操作\n- 先读后写。',
    tasks: [],
    memory: {
      text: '# 长期记忆\n- 喜欢简洁',
      files: [{ name: 'MEMORY.md', size: 30, preview: '喜欢简洁' }],
      count: 1,
      updatedAt: 1,
    },
    activity: [],
  }
}

test('RoleCardsTab：只标记当前卡，分节编辑器显示开场与职责', async () => {
  const view = await mount(
    createElement(RoleCardsTab, {
      detail: samplePerson(),
      busy: false,
      onRefresh: async () => undefined,
    }),
  )
  const text = view.container.textContent ?? ''
  assert.match(text, /正在用/)
  assert.match(text, /只有当前角色卡会写入 AGENTS\.md/)
  assert.match(text, /开场/)
  assert.match(text, /职责/)
  await view.unmount()
})

test('NormsTab：规范按 Markdown 标题分节', async () => {
  const view = await mount(
    createElement(NormsTab, {
      detail: samplePerson(),
      busy: false,
      onRefresh: async () => undefined,
    }),
  )
  const text = view.container.textContent ?? ''
  assert.match(text, /工作规范/)
  assert.match(text, /文件操作/)
  await view.unmount()
})

test('MemoryTab：右上角有整理与清理入口', async () => {
  const view = await mount(
    createElement(MemoryTab, {
      detail: samplePerson(),
      busy: false,
      onRefresh: async () => undefined,
    }),
  )
  const text = view.container.textContent ?? ''
  assert.match(text, /整理记忆/)
  assert.match(text, /清理记忆/)
  await view.unmount()
})
