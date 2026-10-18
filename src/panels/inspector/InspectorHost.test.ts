/**
 * 统一检视器分发单测（v3 T8.2）
 *
 * 覆盖 activePanelId × SelectionDescriptor 的分支：文件信息 / 资产基本信息 /
 * 无激活面板提示；UI/蓝图分支由各自既有测试覆盖（避免重复挂载重组件）。
 */
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { useDockStore } from '@/shell/dock/store'
import { useSelectionStore } from '@/shell/selection/store'
import { useWorkspaceStore } from '@/shell/workspace-store'

const win = new Window()
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document

const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { InspectorHost } = await import('./InspectorHost')

async function mount(): Promise<{ root: ReturnType<typeof createRoot>; el: HTMLElement }> {
  const el = win.document.createElement('div')
  win.document.body.appendChild(el)
  const root = createRoot(el as unknown as Parameters<typeof createRoot>[0])
  root.render(createElement(InspectorHost))
  await new Promise((r) => setTimeout(r, 20))
  return { root, el: el as unknown as HTMLElement }
}

function text(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

before(() => {
  useWorkspaceStore.setState({
    currentProject: { name: 'Demo', path: 'Demo' },
    openTabs: [
      { id: 'script:logic/a.ts', kind: 'script', assetPath: 'logic/a.ts', title: 'a.ts', dirty: true },
    ],
    activeTabId: 'script:logic/a.ts',
  })
})

afterEach(() => {
  useDockStore.setState(useDockStore.getInitialState())
  useSelectionStore.setState({ selection: null })
})

describe('InspectorHost 四源分发', () => {
  it('file-system + file descriptor → 文件基本信息（名称/路径/扩展名）', async () => {
    useDockStore.setState({ activePanelId: 'file-system' })
    useSelectionStore.getState().publish({
      source: 'file',
      path: 'Demo/ui/main.ui.json',
      name: 'main.ui.json',
      kind: 'file',
      ext: 'json',
    })
    const { root, el } = await mount()
    const t = text(el)
    assert.match(t, /main\.ui\.json/)
    assert.match(t, /Demo\/ui\/main\.ui\.json/)
    assert.match(t, /\.json/)
    root.unmount()
  })

  it('file-system 无选中 → 提示选择文件', async () => {
    useDockStore.setState({ activePanelId: 'file-system' })
    const { root, el } = await mount()
    assert.match(text(el), /选择文件或文件夹/)
    root.unmount()
  })

  it('非 UI/蓝图资产 → 资产基本信息（路径 + 未保存状态）', async () => {
    useDockStore.setState({ activePanelId: 'asset:script:logic/a.ts' })
    const { root, el } = await mount()
    const t = text(el)
    assert.match(t, /logic\/a\.ts/)
    assert.match(t, /未保存/)
    root.unmount()
  })

  it('无激活面板 → 空态提示 + 当前项目', async () => {
    useDockStore.setState({ activePanelId: null })
    const { root, el } = await mount()
    const t = text(el)
    assert.match(t, /未激活可检视的面板/)
    assert.match(t, /Demo/)
    root.unmount()
  })
})
