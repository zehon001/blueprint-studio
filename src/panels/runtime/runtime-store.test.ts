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
    useRuntimeStore.getState().openTarget({ project: 'Demo', bp: 'logic/main.bp.json' })
    const s = useRuntimeStore.getState()
    assert.deepEqual(s.target, { project: 'Demo', bp: 'logic/main.bp.json' })
    assert.equal(s.nonce, 1)
    assert.equal(useDockStore.getState().activePanelId, RUNTIME_PANEL_ID)
    assert.ok(useDockStore.getState().root?.kind === 'tabs')
  })

  it('rerun：只增 nonce，不改目标；clearTarget 清目标', () => {
    useRuntimeStore.getState().openTarget({ project: 'P', bp: 'logic/a.bp.json' })
    const target = useRuntimeStore.getState().target
    useRuntimeStore.getState().rerun()
    assert.equal(useRuntimeStore.getState().nonce, 2)
    assert.deepEqual(useRuntimeStore.getState().target, target)
    useRuntimeStore.getState().clearTarget()
    assert.equal(useRuntimeStore.getState().target, null)
  })

  it('重复 openTarget 只维护单实例（面板仍在同一组）', () => {
    useRuntimeStore.getState().openTarget({ project: 'P', bp: 'logic/a.bp.json' })
    useRuntimeStore.getState().openTarget({ project: 'P', bp: 'logic/b.bp.json' })
    const count = JSON.stringify(useDockStore.getState().root).split(RUNTIME_PANEL_ID).length - 1
    assert.equal(count, 1)
    assert.equal(useRuntimeStore.getState().nonce, 2)
  })
})
