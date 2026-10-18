/**
 * 内置运行视图 store 单测（v3 T8.5）
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useRuntimeStore, RUNTIME_PANEL_ID } from './store'
import { useDockStore } from '@/shell/dock/store'
import { makeTabs } from '@/shell/dock/tree'

describe('runtime store', () => {
  afterEach(() => {
    useRuntimeStore.setState({ target: null, nonce: 0 })
    useDockStore.setState(useDockStore.getInitialState())
  })

  it('openTarget：设置目标 + nonce 自增 + 打开/聚焦 runtime 面板', () => {
    useDockStore.setState({ root: makeTabs(['console']), activePanelId: 'console' })
    useRuntimeStore.getState().openTarget({ project: 'Demo', mode: 'main' })
    const s = useRuntimeStore.getState()
    assert.deepEqual(s.target, { project: 'Demo', mode: 'main' })
    assert.equal(s.nonce, 1)
    assert.equal(useDockStore.getState().activePanelId, RUNTIME_PANEL_ID)
    assert.ok(useDockStore.getState().root?.kind === 'tabs')
  })

  it('rerun：只增 nonce，不改目标；clearTarget 清目标', () => {
    useRuntimeStore.getState().openTarget({ project: 'P', ui: 'ui/a.ui.json', mode: 'current' })
    const target = useRuntimeStore.getState().target
    useRuntimeStore.getState().rerun()
    assert.equal(useRuntimeStore.getState().nonce, 2)
    assert.deepEqual(useRuntimeStore.getState().target, target)
    useRuntimeStore.getState().clearTarget()
    assert.equal(useRuntimeStore.getState().target, null)
  })

  it('重复 openTarget 只维护单实例（面板仍在同一组）', () => {
    useRuntimeStore.getState().openTarget({ project: 'P', mode: 'main' })
    useRuntimeStore.getState().openTarget({ project: 'P', ui: 'ui/b.ui.json', mode: 'current' })
    const count = JSON.stringify(useDockStore.getState().root).split(RUNTIME_PANEL_ID).length - 1
    assert.equal(count, 1)
    assert.equal(useRuntimeStore.getState().nonce, 2)
  })
})
