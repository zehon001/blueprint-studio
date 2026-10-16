/**
 * 快捷键框架单元测试（T0.5 DoD）
 * 运行：npx tsx --test src/shell/keymap/keymap.test.ts
 */
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachKeyboard,
  checkConflicts,
  comboFromEvent,
  getBindings,
  getConflicts,
  getShortcut,
  listShortcuts,
  normalizeKeys,
  registerDefaultShortcuts,
  registerShortcut,
  resetShortcuts,
  unregisterShortcut,
} from './registry'
import { getDomainState, registerDomainState, resetEditorStore, runCommand } from '../commands'

/* ---- 测试用假容器（结构性实现 addEventListener / removeEventListener） ---- */

interface FakeContainer {
  listeners: Map<string, ((ev: unknown) => void)[]>
  addEventListener(type: string, listener: (ev: unknown) => void): void
  removeEventListener(type: string, listener: (ev: unknown) => void): void
  dispatch(type: string, ev: unknown): void
  listenerCount(type: string): number
}

function createFakeContainer(): FakeContainer {
  const listeners = new Map<string, ((ev: unknown) => void)[]>()
  return {
    listeners,
    addEventListener(type, listener) {
      const arr = listeners.get(type) ?? []
      arr.push(listener)
      listeners.set(type, arr)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener))
    },
    dispatch(type, ev) {
      for (const l of listeners.get(type) ?? []) l(ev)
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length
    },
  }
}

/** 派发伪 keydown 事件，返回 preventDefault / stopPropagation 是否被调用 */
function pressKey(
  container: FakeContainer,
  init: { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; defaultPrevented?: boolean },
): { prevented: boolean; stopped: boolean } {
  let prevented = false
  let stopped = false
  container.dispatch('keydown', {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {
      stopped = true
    },
  })
  return { prevented, stopped }
}

interface BlueprintState {
  nodes: { id: string; title: string }[]
}

beforeEach(() => {
  resetShortcuts() // 清空注册表并恢复内置默认（edit.undo / edit.redo / file.save）
  resetEditorStore()
})

describe('组合键归一化', () => {
  it('大小写 / 顺序 / 别名不敏感，规范化为有序组合键', () => {
    assert.equal(normalizeKeys('ctrl+z'), 'Ctrl+Z')
    assert.equal(normalizeKeys('Z+CTRL'), 'Ctrl+Z')
    assert.equal(normalizeKeys('ctrl+shift+z'), 'Ctrl+Shift+Z')
    assert.equal(normalizeKeys('Shift+Ctrl+Z'), 'Ctrl+Shift+Z')
    assert.equal(normalizeKeys('f5'), 'F5')
    assert.equal(normalizeKeys('meta+z'), 'Ctrl+Z')
    assert.equal(normalizeKeys('cmd+alt+delete'), 'Ctrl+Alt+Delete')
  })

  it('非法格式抛错', () => {
    assert.throws(() => normalizeKeys(''), /非法/)
    assert.throws(() => normalizeKeys('ctrl'), /缺少主键/)
    assert.throws(() => normalizeKeys('ctrl+'), /缺少主键/)
    assert.throws(() => normalizeKeys('a+b'), /多个主键/)
  })

  it('键盘事件映射为规范组合键（Ctrl 与 Meta 等价）', () => {
    assert.equal(comboFromEvent({ key: 'z', ctrlKey: true }), 'Ctrl+Z')
    assert.equal(comboFromEvent({ key: 'Z', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z')
    assert.equal(comboFromEvent({ key: 'z', metaKey: true }), 'Ctrl+Z')
    assert.equal(comboFromEvent({ key: 'y', ctrlKey: true }), 'Ctrl+Y')
    assert.equal(comboFromEvent({ key: 'F5' }), 'F5')
    assert.equal(comboFromEvent({ key: 'Control', ctrlKey: true }), null) // 纯修饰键
  })
})

describe('冲突检测', () => {
  it('重复组合键注册报出冲突（Ctrl+Z 已被 edit.undo 占用）', () => {
    const r = registerShortcut({ id: 'test.copy', label: '复制', keys: 'Ctrl+Z', handler: () => {} })
    assert.deepEqual(r, { ok: false, conflicts: ['edit.undo'] })
    assert.equal(getShortcut('test.copy'), undefined) // 冲突时未注册
    assert.deepEqual(getConflicts(), []) // 未 force，注册表无共存项
    assert.deepEqual(checkConflicts('ctrl+z'), ['edit.undo']) // 预检（大小写不敏感）
    assert.deepEqual(checkConflicts('Ctrl+Z', 'edit.undo'), [])
  })

  it('force 注册可强制共存，getConflicts 持续汇报', () => {
    const r = registerShortcut(
      { id: 'test.copy', label: '复制', keys: 'Ctrl+Z', handler: () => {} },
      { force: true },
    )
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(getConflicts(), [{ keys: 'Ctrl+Z', ids: ['edit.undo', 'test.copy'] }])
  })

  it('Ctrl+Shift+Z 与 Ctrl+Y 同 id 双绑定不冲突', () => {
    // 默认注册已含 edit.redo 的两条绑定
    assert.deepEqual(
      getBindings('edit.redo').map((d) => normalizeKeys(d.keys)),
      ['Ctrl+Shift+Z', 'Ctrl+Y'],
    )
    // 同 id 同组合键重复注册 = 幂等替换，仍 ok
    const r = registerShortcut({ id: 'edit.redo', label: '重做', keys: 'Ctrl+Y', handler: () => {} })
    assert.deepEqual(r, { ok: true })
    assert.equal(getBindings('edit.redo').length, 2)
    assert.deepEqual(getConflicts(), [])
    // 但换一个 id 抢 Ctrl+Y 会与 edit.redo 冲突
    const r2 = registerShortcut({ id: 'test.other', label: '其它', keys: 'Ctrl+Y', handler: () => {} })
    assert.deepEqual(r2, { ok: false, conflicts: ['edit.redo'] })
  })
})

describe('注册表管理', () => {
  it('unregisterShortcut 注销全部绑定', () => {
    assert.deepEqual(
      registerShortcut({ id: 'test.f5', label: '运行', keys: 'F5', handler: () => {} }),
      { ok: true },
    )
    assert.equal(unregisterShortcut('test.f5'), true)
    assert.equal(unregisterShortcut('test.f5'), false)
    assert.equal(getShortcut('test.f5'), undefined)
  })

  it('listShortcuts 汇总供设置界面（含多绑定）', () => {
    const groups = listShortcuts()
    const undoGroup = groups.find((g) => g.id === 'edit.undo')
    assert.deepEqual(undoGroup, { id: 'edit.undo', label: '撤销', bindings: ['Ctrl+Z'] })
    const redoGroup = groups.find((g) => g.id === 'edit.redo')
    assert.deepEqual(redoGroup, { id: 'edit.redo', label: '重做', bindings: ['Ctrl+Shift+Z', 'Ctrl+Y'] })
    const saveGroup = groups.find((g) => g.id === 'file.save')
    assert.deepEqual(saveGroup, { id: 'file.save', label: '保存', bindings: ['Ctrl+S'] })
  })

  it('registerDefaultShortcuts 幂等', () => {
    registerDefaultShortcuts()
    assert.equal(getBindings('edit.undo').length, 1)
    assert.equal(getBindings('edit.redo').length, 2)
  })
})

describe('键盘事件适配', () => {
  it('命中快捷键执行 handler 并 preventDefault，解绑后不再响应', () => {
    const container = createFakeContainer()
    const calls: string[] = []
    registerShortcut({ id: 'test.a', label: 'A', keys: 'Ctrl+K', handler: () => calls.push('a') })
    const detach = attachKeyboard(container as unknown as Window)

    const hit = pressKey(container, { key: 'k', ctrl: true })
    assert.deepEqual(calls, ['a'])
    assert.equal(hit.prevented, true)
    assert.equal(hit.stopped, true)

    const miss = pressKey(container, { key: 'q', ctrl: true }) // 未注册组合键不拦截
    assert.deepEqual(calls, ['a'])
    assert.equal(miss.prevented, false)

    detach()
    assert.equal(container.listenerCount('keydown'), 0)
    pressKey(container, { key: 'k', ctrl: true })
    assert.deepEqual(calls, ['a'])
  })

  it('已被内层处理的事件（defaultPrevented）跳过', () => {
    const container = createFakeContainer()
    let called = false
    registerShortcut({
      id: 'test.b',
      label: 'B',
      keys: 'F2',
      handler: () => {
        called = true
      },
    })
    attachKeyboard(container as unknown as Window)
    const r = pressKey(container, { key: 'F2', defaultPrevented: true })
    assert.equal(called, false)
    assert.equal(r.prevented, false)
  })

  it('force 共存的同组合键多个 handler 依次执行', () => {
    const container = createFakeContainer()
    const calls: string[] = []
    registerShortcut({ id: 't1', label: '1', keys: 'Ctrl+7', handler: () => calls.push('t1') })
    registerShortcut(
      { id: 't2', label: '2', keys: 'ctrl+7', handler: () => calls.push('t2') },
      { force: true },
    )
    attachKeyboard(container as unknown as Window)
    pressKey(container, { key: '7', ctrl: true })
    assert.deepEqual(calls, ['t1', 't2'])
  })
})

describe('默认快捷键接入命令栈（DoD：撤销/重做 handler）', () => {
  it('Ctrl+Z 撤销，Ctrl+Shift+Z 与 Ctrl+Y 重做，作用于统一命令栈', () => {
    registerDomainState<BlueprintState>('blueprint', { nodes: [] })
    runCommand<BlueprintState>('blueprint', '添加节点', (d) => {
      d.nodes.push({ id: 'n1', title: '节点A' })
    })
    const container = createFakeContainer()
    attachKeyboard(container as unknown as Window)
    const nodeCount = () => getDomainState<BlueprintState>('blueprint').nodes.length

    assert.equal(nodeCount(), 1)
    pressKey(container, { key: 'z', ctrl: true }) // edit.undo → 命令栈 undo
    assert.equal(nodeCount(), 0)
    pressKey(container, { key: 'z', ctrl: true, shift: true }) // edit.redo（Ctrl+Shift+Z）
    assert.equal(nodeCount(), 1)
    pressKey(container, { key: 'z', ctrl: true }) // 再撤销
    assert.equal(nodeCount(), 0)
    pressKey(container, { key: 'y', ctrl: true }) // edit.redo（Ctrl+Y）
    assert.equal(nodeCount(), 1)
  })

  it('file.save 默认注册存在（handler 待接）', () => {
    assert.ok(getShortcut('file.save'))
    assert.equal(getShortcut('file.save')?.keys, 'Ctrl+S')
  })
})
