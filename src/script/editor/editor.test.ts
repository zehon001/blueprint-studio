/**
 * Blueprint Studio v2 —— 脚本编辑器单测（node:test，T3.1）
 *
 * 覆盖（任务卡 T3.1 测试清单）：
 *  1. ViewSwitch 组件：两态渲染 + 回调 + 脏标记互锁展示（蓝图视图 + 脚本脏 → 提示）
 *  2. ScriptEditor：happy-dom 挂载（CodeMirror 可挂载；若挂载失败自动降级为
 *     纯状态层测试——EditorState 文档模型 / Mod-s 命令 / 只读 facet——并显式记录）
 *  3. ScriptTab 加载/保存/脏标记状态机（mock fetch：GET→ready→防抖标脏→PUT→清脏→
 *     missing 建空脚本→蓝图视图（T3.8 真渲染接线：无 CSS shim 环境降级只读提示））
 *  4. 蓝图视图注解粗扫：@on/@expose 正则计数纯函数（含 PLAN §9.2 示例、
 *     参数内冒号跳过、裸 @expose、Python 双引号、语言判定）
 *  5. 草稿状态层：防抖只标一次 / flush / reset / dispose（保存节流的纯逻辑面）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createDraftTracker } from './draft'
import { scanScriptAnnotations, scriptLanguageOf } from './scan'
import { createScriptState, makeSaveCommand } from './ScriptEditor'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ============================================================
 * 样本（PLAN §9.2 受控子集示意）
 * ============================================================ */

const SAMPLE_TS = `// log-viewer.ts —— 逻辑资产示意（受控 TS 子集）
@tool('日志查看器')
class LogViewer extends UILogic {
  @expose({ type: 'string', default: 'com.demo.app' })
  packageName: string                    // → 蓝图变量 + Get/Set 节点

  @on('start')                           // → 事件节点：开始
  onStart(): void {
    ui.title.text = '日志分析'
  }

  @on('btnFetch', 'pressed')             // → 事件节点：UI 按钮 pressed
  async fetch(): Promise<void> {
    const lines = await plugins.phoneLog.read({ mode: 'adb', filter: this.packageName })
    ui.list.items = lines
    emit('loaded', lines.length)
  }
}
`

const SAMPLE_PY = `# log_viewer.py —— 受控 Python 子集
@tool("日志查看器")
class LogViewer:
    @expose
    package_name: str = "com.demo.app"

    @on("start")
    def on_start(self):
        pass
`

/* ============================================================
 * 1. 蓝图视图占位信息扫描（纯函数）
 * ============================================================ */

test('scan：PLAN §9.2 示例（2 @on + 1 @expose，字段名跳过参数内冒号）', () => {
  const s = scanScriptAnnotations(SAMPLE_TS)
  assert.equal(s.eventCount, 2)
  assert.deepEqual(s.eventNames, ['start', 'btnFetch'])
  assert.equal(s.exposedCount, 1)
  assert.deepEqual(s.exposedNames, ['packageName'], '@expose 参数内的 type:/default: 不误捕')
})

test('scan：裸 @expose / 多变量 / Python 双引号 / backtick 事件名', () => {
  const s = scanScriptAnnotations(SAMPLE_PY)
  assert.equal(s.eventCount, 1)
  assert.deepEqual(s.eventNames, ['start'])
  assert.equal(s.exposedCount, 1)

  const multi = scanScriptAnnotations(
    ['@expose', 'count: number = 0', '', '@expose({ type: "string" })', 'label: string'].join('\n'),
  )
  assert.equal(multi.exposedCount, 2)
  assert.deepEqual(multi.exposedNames, ['count', 'label'])

  const tick = scanScriptAnnotations('@on(`tick`)\nrun(): void {}')
  assert.deepEqual(tick.eventNames, ['tick'])
})

test('scan：边界（空串 / 无注解 / @onEvent 不误计 / 括号参数嵌套）', () => {
  assert.equal(scanScriptAnnotations('').eventCount, 0)
  assert.equal(scanScriptAnnotations('const a = 1').exposedCount, 0)
  assert.equal(scanScriptAnnotations('@onEvent("x")').eventCount, 0, '@onEvent 不是 @on')
  const nested = scanScriptAnnotations('@expose({ default: f(1), type: "number" })\ncount: number')
  assert.deepEqual(nested.exposedNames, ['count'], '嵌套括号参数整体跳过')
})

test('scriptLanguageOf：.py → py，其余按 ts（大小写不敏感）', () => {
  assert.equal(scriptLanguageOf('logic/a.py'), 'py')
  assert.equal(scriptLanguageOf('logic/a.PY'), 'py')
  assert.equal(scriptLanguageOf('logic/a.ts'), 'ts')
  assert.equal(scriptLanguageOf('logic/a.TSX'), 'ts')
  assert.equal(scriptLanguageOf('logic/a'), 'ts')
})

/* ============================================================
 * 2. 草稿状态层（防抖只标一次 / flush / reset / dispose）
 * ============================================================ */

test('draft：连续变更防抖只标脏一次；回到基线不触发', async () => {
  const calls: string[] = []
  const t = createDraftTracker('a', (text) => calls.push(text), 20)
  assert.equal(t.hasDraft(), false, '初始无草稿')
  t.notifyChange('ab')
  t.notifyChange('abc')
  t.notifyChange('abcd')
  assert.equal(t.hasDraft(), true)
  await sleep(70)
  assert.equal(calls.length, 1, '防抖合并为一次 onDirty')
  assert.equal(calls[0], 'abcd')
  // 基线推进后回到相同文本不再标脏
  t.reset('abcd')
  assert.equal(t.hasDraft(), false)
  t.notifyChange('abcd')
  await sleep(40)
  assert.equal(calls.length, 1)
  t.dispose()
})

test('draft：flush 立即触发挂起的标脏；dispose 取消挂起定时器', async () => {
  const calls: string[] = []
  const t = createDraftTracker('a', (text) => calls.push(text), 50)
  t.notifyChange('b')
  t.flush()
  assert.equal(calls.length, 1, 'flush 立即触发')
  assert.equal(t.text(), 'b')
  t.notifyChange('c')
  t.dispose()
  await sleep(70)
  assert.equal(calls.length, 1, 'dispose 后不再触发')
})

/* ============================================================
 * 3. ScriptEditor 纯状态层（DOM-free：EditorState 文档模型 / 命令 / facet）
 * ============================================================ */

test('state 层：纯 node 可建 EditorState（TS/Py 模式）+ Mod-s 命令 + 只读 facet', () => {
  const saved: string[] = []
  const state = createScriptState({
    text: 'const a = 1\n',
    path: 'logic/a.ts',
    onSave: () => saved.push('ts'),
  })
  assert.equal(state.doc.toString(), 'const a = 1\n')
  assert.equal(state.facet(EditorState.readOnly), false, '默认非只读')

  const ro = createScriptState({ text: 'x', path: 'logic/a.ts', readOnly: true })
  assert.equal(ro.facet(EditorState.readOnly), true, '只读模式 readOnly facet 打开')

  const cmd = makeSaveCommand(() => saved.push('cmd'))
  const ran = cmd({ state, dispatch: () => {} } as unknown as EditorView)
  assert.equal(ran, true, '保存命令返回 true（吞浏览器默认保存）')
  assert.deepEqual(saved, ['cmd'])
  // 可编辑 facet 挂在 EditorView 上（EditorState.readOnly 在 state 侧）
  const withView = createScriptState({ text: 'x', path: 'logic/a.ts' })
  assert.equal(withView.facet(EditorView.editable), true)
})

/* ============================================================
 * 4. DOM 冒烟（happy-dom：ViewSwitch / ScriptEditor / ScriptTab / 占位面板）
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
    /* 只读全局（如 Node 的 navigator）：跳过 */
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
  'InputEvent',
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
  const value = (dom as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
// CodeMirror 视口测量所需的最小桩（仅测试环境；挂载失败仍会走降级断言）
if (typeof (globalThis as Record<string, unknown>).ResizeObserver === 'undefined') {
  setGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ViewSwitch } = await import('./ViewSwitch')
const { ScriptEditor } = await import('./ScriptEditor')
const { ScriptTab } = await import('./ScriptTab')
const { useWorkspaceStore, tabIdOf } = await import('@/shell/workspace-store')

/** React 元素挂载到 happy-dom body（返回卸载函数） */
function mount(node: ReturnType<typeof createElement>): () => Promise<void> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  act(() => {
    root.render(node)
  })
  return () =>
    act(async () => {
      root.unmount()
      container.remove()
    })
}

/** 点击元素（React onClick 需要 act 包裹） */
function click(el: Element): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

/** 轮询等待条件成立（返回最终是否成立） */
async function waitFor(cond: () => boolean, ms = 1000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await act(async () => {
      await sleep(10)
    })
  }
  return cond()
}

/** CodeMirror DOM 可挂载性探测（失败则 ScriptEditor 用例自动降级并显式记录） */
let cmDomError: unknown = null
function probeCodeMirrorDom(): boolean {
  try {
    const host = dom.document.createElement('div')
    dom.document.body.appendChild(host)
    const view = new EditorView({ state: EditorState.create({ doc: 'x' }), parent: host as unknown as HTMLElement })
    view.destroy()
    host.remove()
    return true
  } catch (err) {
    cmDomError = err
    return false
  }
}
const cmDomOk = probeCodeMirrorDom()

/* ---------------- 4.1 ViewSwitch ---------------- */

test('DOM：ViewSwitch 两态渲染 + 回调', async () => {
  dom.document.body.innerHTML = ''
  let picked: string | null = null
  const unmount = mount(
    createElement(ViewSwitch, { view: 'script', onChange: (v: string) => (picked = v) }),
  )
  try {
    const tabs = [...dom.document.querySelectorAll('.script-view-switch-btn')] as unknown as HTMLButtonElement[]
    assert.equal(tabs.length, 2)
    assert.equal(tabs[0]?.textContent, '蓝图')
    assert.equal(tabs[1]?.textContent, '脚本')
    assert.equal(tabs[0]?.getAttribute('aria-selected'), 'false')
    assert.equal(tabs[1]?.getAttribute('aria-selected'), 'true')
    assert.equal(dom.document.querySelector('.script-view-switch-dirty'), null, '脚本视图不显示互锁提示')
    click(tabs[0] as HTMLButtonElement)
    assert.equal(picked, 'blueprint', '点击蓝图回调')
  } finally {
    await unmount()
  }
})

test('DOM：ViewSwitch 脏标记互锁（蓝图视图 + 脚本脏 → 提示；无脏 / 脚本视图无提示）', async () => {
  dom.document.body.innerHTML = ''
  const unmount = mount(
    createElement(ViewSwitch, { view: 'blueprint', onChange: () => {}, scriptDirty: true }),
  )
  try {
    const hint = dom.document.querySelector('.script-view-switch-dirty')
    assert.ok(hint, '蓝图视图 + 脚本脏 → 显示提示')
    assert.equal(hint?.textContent, '脚本有未保存修改')
    const bpTab = dom.document.querySelector('.script-view-switch-btn') as unknown as HTMLButtonElement
    assert.equal(bpTab.getAttribute('aria-selected'), 'true')
  } finally {
    await unmount()
  }
  // 无脏 → 无提示
  dom.document.body.innerHTML = ''
  const unmount2 = mount(createElement(ViewSwitch, { view: 'blueprint', onChange: () => {} }))
  try {
    assert.equal(dom.document.querySelector('.script-view-switch-dirty'), null)
  } finally {
    await unmount2()
  }
})

/* ---------------- 4.2 ScriptEditor（挂载失败自动降级） ---------------- */

test('DOM：ScriptEditor 挂载（行号/内容/诊断占位徽标/onChange/Mod-S/只读）', async () => {
  dom.document.body.innerHTML = ''
  if (!cmDomOk) {
    // 降级路径：纯状态层已在上面覆盖；此处显式记录失败原因后通过
    console.log(`[降级] happy-dom 无法创建 CodeMirror EditorView：${String(cmDomError)}`)
    assert.ok(createScriptState({ text: 'x', path: 'logic/a.ts' }), '降级：状态层仍可用')
    return
  }
  const changes: string[] = []
  let saved = 0
  let readyView: EditorView | null = null
  const unmount = mount(
    createElement(ScriptEditor, {
      path: 'logic/log.ts',
      value: SAMPLE_TS,
      onChange: (t: string) => changes.push(t),
      onSave: () => {
        saved++
      },
      onReady: (v: EditorView) => {
        readyView = v
      },
    }),
  )
  try {
    assert.ok(dom.document.querySelector('.cm-editor'), 'CodeMirror 根节点渲染')
    assert.ok(dom.document.querySelector('.cm-lineNumbers'), '行号槽渲染')
    assert.ok(
      (readyView as EditorView | null)?.state.doc.toString().startsWith('// log-viewer.ts'),
      '初值文档载入（onReady 暴露 view）',
    )
    assert.equal(
      dom.document.querySelector('.script-editor-lint-badge'),
      null,
      'T3.6 诊断占位徽标已撤除（行列诊断由 ScriptTab 顶栏渲染，T3.8）',
    )

    // 编辑 → onChange 全文回调
    const view = readyView as unknown as EditorView
    view.dispatch({ changes: { from: 0, insert: '// edited\n' } })
    assert.equal(changes.length, 1)
    assert.ok(changes[0]?.startsWith('// edited\n'), 'onChange 上报全文草稿')

    // Ctrl+S（Mod-s）→ onSave + preventDefault（避免浏览器保存对话框）
    const before = saved
    const ev = new dom.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(ev as unknown as Event)
    assert.equal(saved, before + 1, 'Mod-s 触发保存回调')
    assert.equal(ev.defaultPrevented, true, '默认保存行为被吞')
  } finally {
    await unmount()
  }
})

test('DOM：ScriptEditor 只读模式（contenteditable=false，双视图 codegen 只读复用）', async () => {
  if (!cmDomOk) {
    console.log('[降级] 只读模式 DOM 断言跳过')
    return
  }
  dom.document.body.innerHTML = ''
  const unmount = mount(createElement(ScriptEditor, { path: 'logic/a.ts', value: 'const ro = true', readOnly: true }))
  try {
    const content = dom.document.querySelector('.cm-content')
    assert.ok(content)
    assert.equal(content?.getAttribute('contenteditable'), 'false', '只读不可编辑')
  } finally {
    await unmount()
  }
})

/* ---------------- 4.3 ScriptTab 状态机（mock fetch） ---------------- */

/** fetch 调用记录 */
interface FetchCall {
  url: string
  method: string
  body: { path?: string; content?: string } | null
}

function installFetchMock(initial: { ok: boolean; content?: string; message?: string }): {
  calls: FetchCall[]
  setGetResponse: (r: { ok: boolean; content?: string; message?: string }) => void
  restore: () => void
} {
  const calls: FetchCall[] = []
  let getResponse = initial
  const original = globalThis.fetch
  const mock = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: FetchCall['body'] = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as FetchCall['body']
      } catch {
        body = null
      }
    }
    calls.push({ url, method, body })
    if (method === 'GET') return Promise.resolve({ json: async () => getResponse } as Response)
    return Promise.resolve({ json: async () => ({ ok: true }) } as Response)
  }) as typeof fetch
  globalThis.fetch = mock
  return {
    calls,
    setGetResponse: (r) => {
      getResponse = r
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const SCRIPT_TAB = tabIdOf('script', 'logic/log-viewer.ts')

function resetWorkspace(): void {
  useWorkspaceStore.setState({
    currentProject: { name: 'demo', path: 'D:/proj/demo' },
    openTabs: [
      { id: SCRIPT_TAB, kind: 'script', assetPath: 'logic/log-viewer.ts', title: 'log-viewer.ts' },
    ],
    activeTabId: SCRIPT_TAB,
  })
}

function tabDirty(): boolean {
  return useWorkspaceStore.getState().openTabs.find((t) => t.id === SCRIPT_TAB)?.dirty ?? false
}

/** 当前编辑器视图（经 CM 的 findFromDOM 取 ScriptTab 内部实例） */
function editorViewOf(): EditorView | null {
  const el = dom.document.querySelector('.script-editor .cm-editor')
  return el ? EditorView.findFromDOM(el as unknown as HTMLElement) ?? null : null
}

test('DOM：ScriptTab 加载→编辑→防抖标脏→Ctrl+S PUT 清脏→蓝图视图（真渲染降级路径）', async () => {
  dom.document.body.innerHTML = ''
  resetWorkspace()
  const mock = installFetchMock({ ok: true, content: SAMPLE_TS })
  const unmount = mount(createElement(ScriptTab, { assetPath: 'logic/log-viewer.ts', dirtyDebounceMs: 20 }))
  try {
    // 加载：GET → ready → CodeMirror 渲染
    assert.ok(await waitFor(() => dom.document.querySelector('.cm-content') !== null), '加载后编辑器渲染')
    assert.equal(mock.calls[0]?.method, 'GET')
    assert.ok(mock.calls[0]?.url.includes('D%3A%2Fproj%2Fdemo%2Flogic%2Flog-viewer.ts'), 'GET 路径编码正确')
    assert.equal(editorViewOf()?.state.doc.toString(), SAMPLE_TS, '文档与磁盘内容一致')
    assert.ok(dom.document.body.textContent?.includes('TypeScript'), '语言徽标')

    // 编辑 → 300ms（此处 20ms）防抖 → workspace markDirty（tab ●）
    const view = editorViewOf() as EditorView
    view.dispatch({ changes: { from: 0, insert: '// draft\n' } })
    assert.equal(tabDirty(), false, '防抖窗口内未标脏')
    assert.ok(await waitFor(() => tabDirty()), '防抖后标脏')
    assert.ok(dom.document.body.textContent?.includes('● 未保存'), '脏标记展示')

    // Ctrl+S（编辑器 Mod-s keymap → ScriptTab save）→ PUT → 清脏
    view.contentDOM.dispatchEvent(
      new dom.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }) as unknown as Event,
    )
    assert.ok(await waitFor(() => !tabDirty()), '保存成功清脏')
    const put = mock.calls.find((c) => c.method === 'PUT')
    assert.ok(put, '发起 PUT /api/file')
    assert.equal(put?.body?.path, 'D:/proj/demo/logic/log-viewer.ts')
    assert.ok(put?.body?.content?.startsWith('// draft\n'), '保存的是草稿全文（含未保存编辑）')

    // 蓝图视图：T3.8 真渲染——ScriptTab 动态 import BlueprintEditorPanel（@/blueprint
    // barrel 含 .css import；本文件未装 CSS shim → 加载失败 → 降级只读提示），
    // 脚本脏时同步协议提示条出现（保存者胜：缺省基于已保存版本渲染）。
    // （先制造一个草稿再切视图：提示应出现）
    const view2 = editorViewOf() as EditorView
    view2.dispatch({ changes: { from: 0, insert: '@expose\nextra: number = 1\n' } })
    await waitFor(() => tabDirty())
    click(dom.document.querySelector('.script-view-switch-btn') as unknown as HTMLButtonElement) // 蓝图
    assert.ok(
      await waitFor(() => dom.document.querySelector('.script-tab-syncbar') !== null),
      '切到蓝图视图出现脏冲突提示条',
    )
    const text = dom.document.body.textContent ?? ''
    assert.ok(text.includes('脚本有未保存修改'), '同步协议提示（保存者胜：蓝图基于已保存版本）')
    assert.ok(
      await waitFor(() => (dom.document.body.textContent ?? '').includes('蓝图面板加载失败')),
      '无 CSS shim 环境（node:test）面板加载失败 → 降级只读提示（不白屏）',
    )
    // 切回脚本视图
    click((dom.document.querySelectorAll('.script-view-switch-btn')[1] ?? null) as unknown as HTMLButtonElement)
    assert.ok(await waitFor(() => dom.document.querySelector('.cm-content') !== null), '切回脚本视图')
  } finally {
    await unmount()
    mock.restore()
    useWorkspaceStore.getState().clearDirty(SCRIPT_TAB)
  }
})

test('DOM：ScriptTab missing → 创建空脚本（PUT 引导注释头）→ 重新加载', async () => {
  dom.document.body.innerHTML = ''
  resetWorkspace()
  const mock = installFetchMock({ ok: false, message: '文件不存在：logic/new.ts' })
  const unmount = mount(createElement(ScriptTab, { assetPath: 'logic/new.ts' }))
  try {
    assert.ok(await waitFor(() => (dom.document.body.textContent ?? '').includes('资产不存在')))
    const createBtn = dom.document.querySelector('.workspace-tab-create') as unknown as HTMLButtonElement
    assert.ok(createBtn, '提供创建空脚本按钮')
    mock.setGetResponse({ ok: true, content: '' })
    click(createBtn)
    assert.ok(await waitFor(() => dom.document.querySelector('.cm-content') !== null), '创建后重新加载')
    const put = mock.calls.find((c) => c.method === 'PUT')
    assert.ok(put, '创建发起 PUT')
    assert.ok(put?.body?.content?.includes('new.ts'), '引导注释头含资产名')
  } finally {
    await unmount()
    mock.restore()
  }
})

test('DOM：ScriptTab 加载失败（网络错误）显示错误信息', async () => {
  dom.document.body.innerHTML = ''
  resetWorkspace()
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch
  const unmount = mount(createElement(ScriptTab, { assetPath: 'logic/log-viewer.ts' }))
  try {
    assert.ok(
      await waitFor(() => (dom.document.body.textContent ?? '').includes('网络错误')),
      '网络错误显式展示',
    )
  } finally {
    await unmount()
    globalThis.fetch = original
  }
})
