/**
 * 统一选择协议单测（v3 T8.2）
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useSelectionStore, selectionOfPanel, type SelectionDescriptor } from './store'

const ui: SelectionDescriptor = {
  source: 'ui',
  panelId: 'asset:ui:ui/main.ui.json',
  assetPath: 'ui/main.ui.json',
  nodeIds: ['n1'],
}
const file: SelectionDescriptor = {
  source: 'file',
  path: 'Demo/ui/main.ui.json',
  name: 'main.ui.json',
  kind: 'file',
  ext: 'json',
}

describe('selection store', () => {
  afterEach(() => useSelectionStore.setState({ selection: null }))

  it('publish / selectionOfPanel：UI 描述符仅在对应面板匹配时返回', () => {
    useSelectionStore.getState().publish(ui)
    assert.deepEqual(useSelectionStore.getState().selection, ui)
    assert.equal(selectionOfPanel(ui, 'asset:ui:ui/main.ui.json'), ui)
    assert.equal(selectionOfPanel(ui, 'asset:ui:other.ui.json'), null)
    assert.equal(selectionOfPanel(ui, null), null)
  })

  it('clear：只清同 source/panel，避免误清新选择', () => {
    useSelectionStore.getState().publish(ui)
    useSelectionStore.getState().clear('ui', 'asset:ui:other.ui.json')
    assert.deepEqual(useSelectionStore.getState().selection, ui, '不匹配 panelId 不清')
    useSelectionStore.getState().clear('file')
    assert.deepEqual(useSelectionStore.getState().selection, ui, 'source 不匹配不清')
    useSelectionStore.getState().clear('ui', 'asset:ui:ui/main.ui.json')
    assert.equal(useSelectionStore.getState().selection, null)
  })

  it('file descriptor：不绑定面板 id，由 activePanelId=file-system 分发', () => {
    useSelectionStore.getState().publish(file)
    assert.equal(selectionOfPanel(file, 'file-system'), file)
    assert.equal(selectionOfPanel(null, 'file-system'), null)
  })
})
