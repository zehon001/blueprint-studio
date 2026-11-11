/** 人员概览：任务看板预览与全部任务弹窗。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { PersonDetail, PersonTask } from '@/shared/personnel'

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
const { OverviewTab } = await import('./OverviewTab')

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

function makeTask(index: number): PersonTask {
  return {
    id: `task-${index}`,
    title: `任务 ${index}`,
    content: `任务 ${index} 的内容`,
    status: 'completed',
    createdAt: index,
    startedAt: index,
    finishedAt: index + 1,
  }
}

function sampleDetail(tasks: PersonTask[]): PersonDetail {
  return {
    id: 'p-test',
    name: '测试人员',
    typeId: 'general',
    avatarUrl: '',
    createdAt: 1,
    updatedAt: 1,
    defaultWorkspace: '/tmp/workspace',
    activeWorkspace: '/tmp/workspace',
    roleCardCount: 0,
    memoryCount: 0,
    stats: { runs: 0, completed: 0, failed: 0 },
    run: { status: 'idle' },
    queue: { status: 'idle', total: tasks.length, completed: tasks.length, failed: 0 },
    taskCounts: {
      total: tasks.length,
      pending: 0,
      running: 0,
      completed: tasks.length,
      failed: 0,
      stopped: 0,
    },
    config: {
      id: 'p-test',
      name: '测试人员',
      typeId: 'general',
      createdAt: 1,
      updatedAt: 1,
      task: '',
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
    cards: [],
    norms: '',
    tasks,
    memory: { text: '', files: [], count: 0 },
    activity: [],
  }
}

test('任务看板概览只显示前 3 条，全部任务弹窗显示完整列表', async () => {
  const detail = sampleDetail(Array.from({ length: 5 }, (_, index) => makeTask(index + 1)))
  const view = await mount(
    createElement(OverviewTab, {
      person: detail,
      detail,
      onRefresh: async () => undefined,
    }),
  )

  try {
    assert.equal(
      view.container.querySelectorAll('.pp-task-row').length,
      3,
      '概览只渲染前 3 条任务',
    )
    const previewText = view.container.textContent ?? ''
    assert.match(previewText, /任务 1/)
    assert.match(previewText, /任务 3/)
    assert.doesNotMatch(previewText, /任务 5/)

    const button = [...view.container.querySelectorAll('button')].find((item) =>
      (item.textContent ?? '').includes('查看全部任务'),
    )
    assert.ok(button, '任务看板有查看全部任务按钮')
    await act(async () => {
      button.click()
    })

    const modal = dom.document.querySelector('.pp-task-modal')
    assert.ok(modal, '点击后打开全部任务弹窗')
    assert.equal(modal.querySelectorAll('.pp-task-row').length, 5, '弹窗显示全部任务')
    assert.match(modal.textContent ?? '', /任务 5/)
  } finally {
    await view.unmount()
  }
})
