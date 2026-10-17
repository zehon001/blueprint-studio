/**
 * 改键设置逻辑单元测试（T7.1 DoD：可查可改 + 冲突检测 + 改键持久化）
 *
 * 覆盖：
 *  1. 持久化（persist）：序列化 / 反序列化容错（非法 JSON / 版本不符 / 非法条目剔除 /
 *     组合键归一化）+ localStorage 读写清（桩后端）；
 *  2. 可捕获判定（isBindableCombo）：修饰键 / F 键 / 导航键放行，裸字符 / Backspace /
 *     Esc / 非法格式拒绝；
 *  3. 改键原语（rebindShortcut）：成功替换（handler 保留、旧组合键释放）、冲突拒绝
 *     （注册表不动）、多绑定收拢、未知 id 抛错、上下文键冲突保护与可改键；
 *  4. 上下文键（contextual）：全表存在且默认表无冲突；attachKeyboard 派发跳过
 *     （handler 不执行、不 preventDefault，画布现状不受影响）；
 *  5. 默认表回放（registerDefaultShortcut）：resetShortcuts 重建后入口级默认项还原；
 *  6. 改键编排（customize）：rebindAndPersist 落盘时机（冲突不落盘）、
 *     applyKeymapOverrides 逐条回放与失效跳过、restoreDefaultsAndPersist 一键还原；
 *  7. 组件冒烟（happy-dom 挂载）：分组 / 键位 / 上下文徽标渲染、改键捕获流、
 *     冲突红字拒绝、Esc 取消、恢复默认。
 *
 * 运行：npx tsx --test src/shell/keymap/settings.test.ts
 */
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachKeyboard,
  checkConflicts,
  getBindings,
  getConflicts,
  getShortcut,
  listShortcuts,
  rebindShortcut,
  registerDefaultShortcut,
  registerShortcut,
  resetShortcuts,
} from './registry'
import {
  KEYMAP_STORAGE_KEY,
  clearKeymapOverrides,
  deserializeKeymapOverrides,
  loadKeymapOverrides,
  saveKeymapOverrides,
  serializeKeymapOverrides,
} from './persist'
import {
  applyKeymapOverrides,
  isBindableCombo,
  rebindAndPersist,
  restoreDefaultsAndPersist,
} from './customize'

/* ============================================================
 * happy-dom 环境（组件冒烟用；localStorage 取自 dom，全文件共用）
 * ============================================================ */
import { Window } from 'happy-dom'

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
  'PointerEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { act } = await import('react')
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SettingsPanel } = await import('@/panels/settings/SettingsPanel')

/* ---- 测试用假容器（结构性实现 addEventListener / removeEventListener，见 keymap.test） ---- */

/** attachKeyboard 的容器参数类型（本文件 Window 名被 happy-dom 的 Window 占用，双跳桥接用） */
type KeyboardTarget = Parameters<typeof attachKeyboard>[0]

interface FakeContainer {
  listeners: Map<string, ((ev: unknown) => void)[]>
  addEventListener(type: string, listener: (ev: unknown) => void): void
  removeEventListener(type: string, listener: (ev: unknown) => void): void
  dispatch(type: string, ev: unknown): void
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
  }
}

/** 派发伪 keydown 事件，返回 preventDefault 是否被调用 */
function pressKey(
  container: FakeContainer,
  init: { key: string; ctrl?: boolean; shift?: boolean },
): { prevented: boolean } {
  let prevented = false
  container.dispatch('keydown', {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: false,
    altKey: false,
    shiftKey: init.shift ?? false,
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {},
  })
  return { prevented }
}

beforeEach(() => {
  resetShortcuts() // 清空注册表并恢复默认表（内置 + 复制粘贴族上下文键）
  dom.window.localStorage.clear() // 改键覆盖清空，用例间互不污染
})

/* ============================================================
 * 1. 持久化（persist）
 * ============================================================ */

describe('改键持久化 serializeKeymapOverrides / deserializeKeymapOverrides', () => {
  it('序列化 / 反序列化往返一致', () => {
    const json = serializeKeymapOverrides({ 'edit.undo': 'Ctrl+K', 'run.main': 'F9' })
    assert.deepEqual(deserializeKeymapOverrides(json), { 'edit.undo': 'Ctrl+K', 'run.main': 'F9' })
  })

  it('非法 JSON / 版本不符 / overrides 非对象 → 空覆盖', () => {
    assert.deepEqual(deserializeKeymapOverrides('{broken'), {})
    assert.deepEqual(deserializeKeymapOverrides(JSON.stringify({ version: 2, overrides: {} })), {})
    assert.deepEqual(deserializeKeymapOverrides(JSON.stringify({ version: 1, overrides: 'x' })), {})
    assert.deepEqual(deserializeKeymapOverrides('null'), {})
  })

  it('非法条目剔除（空 id / 值非字符串 / 组合键非法），合法条目归一化保留', () => {
    const json = JSON.stringify({
      version: 1,
      overrides: { 'edit.undo': 'z+ctrl', '': 'Ctrl+K', bad: 123, broken: 'ctrl' },
    })
    assert.deepEqual(deserializeKeymapOverrides(json), { 'edit.undo': 'Ctrl+Z' })
  })
})

describe('改键持久化 localStorage 读写清', () => {
  it('save 后 load 一致；clear 后为空', () => {
    saveKeymapOverrides({ 'edit.undo': 'Ctrl+K' })
    assert.deepEqual(loadKeymapOverrides(), { 'edit.undo': 'Ctrl+K' })
    assert.equal(dom.window.localStorage.getItem(KEYMAP_STORAGE_KEY), serializeKeymapOverrides({ 'edit.undo': 'Ctrl+K' }))
    clearKeymapOverrides()
    assert.equal(dom.window.localStorage.getItem(KEYMAP_STORAGE_KEY), null)
    assert.deepEqual(loadKeymapOverrides(), {})
  })

  it('存储中的脏数据（非法条目）读取时剔除，不阻塞启动', () => {
    dom.window.localStorage.setItem(KEYMAP_STORAGE_KEY, '{"version":1,"overrides":{"edit.undo":"Ctrl+K","x":"ctrl+"}}')
    assert.deepEqual(loadKeymapOverrides(), { 'edit.undo': 'Ctrl+K' })
  })
})

/* ============================================================
 * 2. 可捕获判定（isBindableCombo）
 * ============================================================ */

describe('可捕获组合键判定 isBindableCombo', () => {
  it('放行：Ctrl / Alt 修饰、F 功能键、非录入导航键', () => {
    assert.equal(isBindableCombo('Ctrl+K'), true)
    assert.equal(isBindableCombo('Ctrl+Alt+D'), true)
    assert.equal(isBindableCombo('Ctrl+Shift+Z'), true)
    assert.equal(isBindableCombo('Alt+F2'), true)
    assert.equal(isBindableCombo('F5'), true)
    assert.equal(isBindableCombo('F12'), true)
    assert.equal(isBindableCombo('Delete'), true)
    assert.equal(isBindableCombo('Home'), true)
    assert.equal(isBindableCombo('PageDown'), true)
  })

  it('拒绝：裸字符 / 仅 Shift / Backspace / Escape / 非法格式（防劫持文本录入与取消惯例）', () => {
    assert.equal(isBindableCombo('D'), false)
    assert.equal(isBindableCombo('Shift+D'), false)
    assert.equal(isBindableCombo('Backspace'), false)
    assert.equal(isBindableCombo('Escape'), false)
    assert.equal(isBindableCombo('Ctrl'), false)
    assert.equal(isBindableCombo(''), false)
    assert.equal(isBindableCombo('a+b'), false)
  })
})

/* ============================================================
 * 3. 改键原语（rebindShortcut）
 * ============================================================ */

describe('改键原语 rebindShortcut', () => {
  it('改键成功：绑定替换为新组合键，handler 保留，旧组合键释放', () => {
    const calls: string[] = []
    registerShortcut({ id: 'test.op', label: '测试', keys: 'Ctrl+7', handler: () => calls.push('op') })
    const r = rebindShortcut('test.op', 'Ctrl+8')
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(
      getBindings('test.op').map((d) => d.keys),
      ['Ctrl+8'],
    )
    // 旧组合键已释放：可被其它 id 注册
    assert.deepEqual(registerShortcut({ id: 'test.other', label: '其它', keys: 'Ctrl+7', handler: () => {} }), {
      ok: true,
    })
    // handler 沿用原绑定：新组合键触发原 handler
    const container = createFakeContainer()
    attachKeyboard(container as unknown as KeyboardTarget)
    pressKey(container, { key: '8', ctrl: true })
    assert.deepEqual(calls, ['op'])
  })

  it('冲突拒绝：返回占用者列表且注册表不动', () => {
    const before = getBindings('edit.undo').map((d) => d.keys)
    const r = rebindShortcut('edit.undo', 'Ctrl+S')
    assert.deepEqual(r, { ok: false, conflicts: ['file.save'] })
    assert.deepEqual(getBindings('edit.undo').map((d) => d.keys), before)
  })

  it('未知 id 抛错', () => {
    assert.throws(() => rebindShortcut('nope.missing', 'Ctrl+1'), /不存在/)
  })

  it('多绑定 id 改键后收拢为单组合键', () => {
    assert.equal(getBindings('edit.redo').length, 2)
    const r = rebindShortcut('edit.redo', 'Ctrl+R')
    assert.deepEqual(r, { ok: true })
    assert.deepEqual(
      getBindings('edit.redo').map((d) => d.keys),
      ['Ctrl+R'],
    )
  })

  it('上下文键参与冲突保护：全局键不得占用画布组合键', () => {
    // edit.copy（contextual，画布用 Ctrl+C）阻挡 edit.undo 改键到 Ctrl+C
    assert.deepEqual(rebindShortcut('edit.undo', 'Ctrl+C'), { ok: false, conflicts: ['edit.copy'] })
    // 反向：把 edit.copy 改键到空闲组合键可成功（注册表层面生效）
    assert.deepEqual(rebindShortcut('edit.copy', 'Ctrl+Shift+C'), { ok: true })
    assert.deepEqual(
      getBindings('edit.copy').map((d) => d.keys),
      ['Ctrl+Shift+C'],
    )
  })
})

/* ============================================================
 * 4. 上下文键（contextual）
 * ============================================================ */

describe('上下文键（contextual）', () => {
  it('默认全表含复制粘贴族；默认表无冲突；全局键不受影响', () => {
    const byId = new Map(listShortcuts().map((g) => [g.id, g]))
    assert.deepEqual(byId.get('edit.copy')?.bindings, ['Ctrl+C'])
    assert.equal(byId.get('edit.copy')?.contextual, true)
    assert.deepEqual(byId.get('edit.delete')?.bindings, ['Delete', 'Backspace'])
    assert.equal(byId.get('edit.selectAll')?.contextual, true)
    assert.equal(byId.get('edit.undo')?.contextual, undefined) // 全局键无标记
    assert.deepEqual(getConflicts(), []) // 全表（含上下文键）默认无冲突
  })

  it('attachKeyboard 跳过 contextual：handler 不执行、不拦截事件', () => {
    const container = createFakeContainer()
    let called = false
    registerShortcut({
      id: 'test.ctx',
      label: '上下文',
      keys: 'Ctrl+M',
      contextual: true,
      handler: () => {
        called = true
      },
    })
    attachKeyboard(container as unknown as KeyboardTarget)
    const hit = pressKey(container, { key: 'm', ctrl: true })
    assert.equal(called, false)
    assert.equal(hit.prevented, false) // 不拦截：画布等内层交互照常收到事件
    // 同一注册表里非 contextual 键照常派发
    let globalCalled = false
    registerShortcut({
      id: 'test.glob',
      label: '全局',
      keys: 'Ctrl+N',
      handler: () => {
        globalCalled = true
      },
    })
    const hit2 = pressKey(container, { key: 'n', ctrl: true })
    assert.equal(globalCalled, true)
    assert.equal(hit2.prevented, true)
  })

  it('checkConflicts 对上下文键持续可见（设置界面冲突提示的数据源）', () => {
    assert.deepEqual(checkConflicts('ctrl+c'), ['edit.copy'])
    assert.deepEqual(checkConflicts('Delete'), ['edit.delete'])
  })
})

/* ============================================================
 * 5. 默认表回放（registerDefaultShortcut / resetShortcuts）
 * ============================================================ */

describe('默认表回放 registerDefaultShortcut', () => {
  it('resetShortcuts 重建后入口级默认项还原（F5/F6、settings.open 同机制）', () => {
    registerDefaultShortcut({ id: 'test.entry', label: '入口', keys: 'F9', handler: () => {} })
    resetShortcuts()
    assert.equal(getShortcut('test.entry')?.keys, 'F9')
    assert.ok(getShortcut('edit.undo')) // 内置默认仍在
    assert.ok(getShortcut('edit.copy')) // 上下文键仍在
  })

  it('同 id 重复注册替换回放项：reset 后只保留最后注册的键位', () => {
    registerDefaultShortcut({ id: 'test.entry', label: '入口', keys: 'F9', handler: () => {} })
    registerDefaultShortcut({ id: 'test.entry', label: '入口', keys: 'F10', handler: () => {} })
    resetShortcuts()
    assert.deepEqual(
      getBindings('test.entry').map((d) => d.keys),
      ['F10'],
    )
  })
})

/* ============================================================
 * 6. 改键编排（customize）
 * ============================================================ */

describe('改键编排 rebindAndPersist / applyKeymapOverrides / restoreDefaultsAndPersist', () => {
  it('rebindAndPersist 成功：注册表生效 + 覆盖落盘（归一化形）', () => {
    const r = rebindAndPersist('edit.undo', 'k+ctrl')
    assert.deepEqual(r, { ok: true })
    assert.equal(getBindings('edit.undo')[0]?.keys, 'Ctrl+K')
    assert.deepEqual(loadKeymapOverrides(), { 'edit.undo': 'Ctrl+K' })
  })

  it('rebindAndPersist 冲突：拒绝且不落盘', () => {
    const r = rebindAndPersist('edit.undo', 'Ctrl+S')
    assert.deepEqual(r, { ok: false, conflicts: ['file.save'] })
    assert.deepEqual(loadKeymapOverrides(), {})
    assert.equal(getBindings('edit.undo')[0]?.keys, 'Ctrl+Z')
  })

  it('applyKeymapOverrides：逐条回放；冲突条目跳过并报告，不影响其它条目', () => {
    const report = applyKeymapOverrides({ 'edit.undo': 'Ctrl+K', 'file.save': 'Ctrl+K' })
    assert.deepEqual(report.applied, ['edit.undo'])
    assert.deepEqual(report.failed, [{ id: 'file.save', keys: 'Ctrl+K', conflicts: ['edit.undo'] }])
    assert.equal(getBindings('edit.undo')[0]?.keys, 'Ctrl+K')
    assert.equal(getBindings('file.save')[0]?.keys, 'Ctrl+S') // 未被覆盖污染
  })

  it('applyKeymapOverrides：不存在 id 的残留条目跳过', () => {
    const report = applyKeymapOverrides({ 'gone.shortcut': 'Ctrl+1' })
    assert.deepEqual(report.applied, [])
    assert.equal(report.failed.length, 1)
    assert.equal(report.failed[0]?.id, 'gone.shortcut')
  })

  it('restoreDefaultsAndPersist：清空覆盖 + 注册表回默认表，入口级默认项保留', () => {
    rebindAndPersist('edit.undo', 'Ctrl+K')
    registerDefaultShortcut({ id: 'test.entry', label: '入口', keys: 'F9', handler: () => {} })
    restoreDefaultsAndPersist()
    assert.deepEqual(loadKeymapOverrides(), {}) // 持久化已清空
    assert.deepEqual(
      getBindings('edit.undo').map((d) => d.keys),
      ['Ctrl+Z'],
    )
    assert.equal(getShortcut('test.entry')?.keys, 'F9') // 入口级默认项回放
    // 旧自定义组合键已释放
    assert.deepEqual(registerShortcut({ id: 'test.free', label: '空闲', keys: 'Ctrl+K', handler: () => {} }), {
      ok: true,
    })
  })
})

/* ============================================================
 * 7. 组件冒烟（happy-dom 挂载）
 * ============================================================ */

/** 挂载设置面板（无注入依赖；返回卸载函数） */
async function mountPanel(): Promise<{ unmount: () => Promise<void> }> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => {
    root.render(createElement(SettingsPanel))
  })
  return {
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** 在 act 内派发 click（happy-dom Event 体系；any 桥接见 plugin-manager.test 双跳惯例） */
async function click(el: unknown): Promise<void> {
  await act(async () => {
    ;(el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(
      new dom.MouseEvent('click', { bubbles: true, cancelable: true }),
    )
  })
}

/** 在 act 内向 window 派发 keydown（命中面板的捕获阶段监听器） */
async function pressDomKey(key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.KeyboardEvent('keydown', {
        key,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

/** 查询助手（any 桥接 happy-dom 与 TS DOM lib 的 Element 结构差异） */
function q(selector: string): any {
  return dom.document.querySelector(selector)
}
function qAll(selector: string): any[] {
  return [...dom.document.querySelectorAll(selector)]
}

/** 按命令名找行（行内 .bps-settings-name 文本 = 命令名） */
function rowOf(label: string): any {
  return qAll('.bps-settings-row').find((r) => r.querySelector('.bps-settings-name')?.textContent === label)
}

/** 向上找行所属的分组标题（分组 wrapper = 含 .bps-settings-group-title 直接子元素的最近祖先） */
function groupTitleOfRow(row: any): string | null {
  let el: any = row.parentElement
  while (el && el !== dom.document.body) {
    const title = [...el.children].find((c: any) => c.className === 'bps-settings-group-title')
    if (title) return title.textContent
    el = el.parentElement
  }
  return null
}

describe('设置面板组件冒烟（快捷键区块）', () => {
  it('渲染：分组标题、命令行键位、上下文徽标、恢复默认按钮', async () => {
    const h = await mountPanel()
    try {
      const groupTitles = qAll('.bps-settings-group-title').map((g) => g.textContent)
      // 测试环境只注册了内置表（run.* / settings.open 在 main.tsx / defaultPanels 装配时注册）：
      // 「文件 / 编辑」分组存在即分组渲染正常（回放表测试可能遗留 test.entry → 其它组，不在此断言）
      for (const label of ['文件', '编辑']) assert.ok(groupTitles.includes(label), `缺分组：${label}`)
      const undoRow = rowOf('撤销')
      assert.ok(undoRow, '撤销行缺失')
      assert.equal(groupTitleOfRow(undoRow), '编辑', '撤销行应归入「编辑」分组')
      assert.equal(groupTitleOfRow(rowOf('保存')), '文件', '保存行应归入「文件」分组')
      assert.equal(undoRow.querySelector('.bps-settings-kbd')?.textContent, 'Ctrl+Z')
      assert.ok(qAll('.bps-settings-badge').length >= 6, '上下文徽标缺失（复制粘贴族）')
      assert.ok(q('.bps-settings-reset'), '恢复默认按钮缺失')
    } finally {
      await h.unmount()
    }
  })

  it('改键流：点「修改」进监听态 → 按下 Ctrl+K 捕获写入（注册表 + localStorage）', async () => {
    const h = await mountPanel()
    try {
      await click(rowOf('撤销').querySelector('button.bps-settings-edit'))
      assert.ok(q('.bps-settings-capturing'), '监听态提示缺失')
      await pressDomKey('k', { ctrl: true })
      // 注册表已改键 + 覆盖落盘
      assert.equal(getBindings('edit.undo')[0]?.keys, 'Ctrl+K')
      assert.deepEqual(loadKeymapOverrides(), { 'edit.undo': 'Ctrl+K' })
      // 行内键位刷新为新组合键，监听态退出
      const undoRow = rowOf('撤销')
      assert.equal(undoRow.querySelector('.bps-settings-kbd')?.textContent, 'Ctrl+K')
      assert.equal(q('.bps-settings-capturing'), null)
    } finally {
      await h.unmount()
    }
  })

  it('冲突拒绝：占用组合键 → 红字提示、不落盘、保持监听态；不可绑键同样拒绝；Esc 取消', async () => {
    const h = await mountPanel()
    try {
      await click(rowOf('保存').querySelector('button.bps-settings-edit'))
      // Ctrl+Z 已被撤销占用 → 冲突红字，不保存，仍在监听
      await pressDomKey('z', { ctrl: true })
      const err = q('.bps-settings-error')
      assert.ok(err, '冲突红字提示缺失')
      assert.match(err.textContent, /冲突/)
      assert.deepEqual(loadKeymapOverrides(), {})
      assert.ok(q('.bps-settings-capturing'), '冲突后应保持监听态')
      // 裸字母（会劫持文本录入）→ 不可绑提示，仍不落盘
      await pressDomKey('q')
      assert.match(q('.bps-settings-error').textContent, /不可绑/)
      assert.deepEqual(loadKeymapOverrides(), {})
      // Esc 取消：退出监听态、键位不变、提示消失
      await pressDomKey('Escape')
      assert.equal(q('.bps-settings-capturing'), null)
      assert.equal(q('.bps-settings-error'), null)
      assert.equal(rowOf('保存').querySelector('.bps-settings-kbd')?.textContent, 'Ctrl+S')
    } finally {
      await h.unmount()
    }
  })

  it('恢复默认：清空改键回默认表 + 清空持久化覆盖', async () => {
    const h = await mountPanel()
    try {
      // 先制造一条自定义改键
      await click(rowOf('撤销').querySelector('button.bps-settings-edit'))
      await pressDomKey('k', { ctrl: true })
      assert.equal(getBindings('edit.undo')[0]?.keys, 'Ctrl+K')
      // 一键恢复
      await click(q('.bps-settings-reset'))
      assert.deepEqual(loadKeymapOverrides(), {})
      assert.equal(rowOf('撤销').querySelector('.bps-settings-kbd')?.textContent, 'Ctrl+Z')
      assert.equal(getBindings('edit.undo')[0]?.keys, 'Ctrl+Z')
    } finally {
      await h.unmount()
    }
  })
})
