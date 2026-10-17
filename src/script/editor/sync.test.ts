/**
 * Blueprint Studio v2 —— 双视图同步协议测试（node:test，T3.8）
 *
 * 覆盖（任务卡 T3.8 测试清单）：
 *  1. 纯状态机（sync.ts，不依赖 DOM / store / fetch）：
 *     - 初始化不变式 + 视图切换（双向 / 同视图幂等）；
 *     - editScript 携带全文判脏（撤销回基线自动清脏——横幅不误报）；
 *     - 脚本保存成功 / 失败（失败 = 状态不变，草稿保留，DoD 无脏丢失）；
 *     - 蓝图保存成功（保存者胜：基线推进 + 脚本草稿一并失效 + 编辑器重载 effect）
 *       / 失败（蓝图修改保留）；
 *     - 脏冲突横幅派生：以草稿解析 / 放弃草稿；应用并覆盖脚本 / 丢弃蓝图修改；
 *     - 双脏（scriptDirty × blueprintDirty）× 切换 × 保存 × 放弃 全组合关键序。
 *  2. DOM 冒烟（happy-dom + CSS shim：真实 BlueprintEditorPanel / parseScriptToIR）：
 *     - 蓝图视图真渲染（My Blueprint 变量行 / @on 双参 → event.custom 画布节点）；
 *     - 蓝图保存（Ctrl+S 经 keymap 注册表 → 面板 onSave → codegen 覆盖写盘 PUT →
 *       脚本视图重载 CodeMirror 内容——D3 魔法端到端）；
 *     - 蓝图编辑未保存 → 切回脚本横幅 → 「应用并覆盖脚本」→ 草稿写回 + 恢复标脏；
 *     - 脚本保存失败（PUT !ok）→ toast + 草稿保留 + 仍标脏（无脏丢失）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { register as registerLoaderHooks } from 'node:module'
import { EditorView } from '@codemirror/view'
import { attachKeyboard, resetShortcuts } from '@/shell/keymap/registry'
import { resetEditorStore } from '@/shell/commands'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import {
  blueprintDirtyPending,
  initSyncState,
  scriptDraftPending,
  viewStateMachine,
  type SyncEvent,
  type SyncState,
} from './sync'

/* ============================================================
 * 1. 纯状态机
 * ============================================================ */

const SAVED = '// saved on disk\n'

function send(s: SyncState, e: SyncEvent): SyncState {
  return viewStateMachine(s, e).state
}

test('init：初始状态不变式（脚本视图 / 干净 / 蓝图基准 = 已保存版本）', () => {
  const s = initSyncState(SAVED)
  assert.equal(s.view, 'script')
  assert.equal(s.savedText, SAVED)
  assert.equal(s.scriptDirty, false)
  assert.equal(s.blueprintDirty, false)
  assert.equal(s.blueprintBase, 'saved')
  assert.equal(scriptDraftPending(s), false)
  assert.equal(blueprintDirtyPending(s), false)
})

test('switchView：双向切换 + 同视图幂等（状态引用不变）', () => {
  const s = initSyncState(SAVED)
  const bp = send(s, { type: 'switchView', view: 'blueprint' })
  assert.equal(bp.view, 'blueprint')
  assert.equal(bp.savedText, SAVED, '切换不改变基线')
  const back = send(bp, { type: 'switchView', view: 'script' })
  assert.equal(back.view, 'script')
  assert.ok(send(s, { type: 'switchView', view: 'script' }) === s, '同视图切换为恒等转换')
})

test('editScript：携带全文对比基线判脏；撤销回基线自动清脏（横幅不误报）', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'editScript', text: SAVED + '// draft\n' })
  assert.equal(s.scriptDirty, true)
  // 撤销回基线：脏态清除
  s = send(s, { type: 'editScript', text: SAVED })
  assert.equal(s.scriptDirty, false)
  assert.equal(scriptDraftPending(send(s, { type: 'switchView', view: 'blueprint' })), false)
})

test('saveScriptOk：基线推进 + 脚本清脏 + blueprintBase 复位（蓝图基于新 IR）', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'editScript', text: 'draft-1' })
  s = send(s, { type: 'switchView', view: 'blueprint' })
  assert.equal(scriptDraftPending(s), true, '蓝图视图出现脚本草稿提示')
  s = send(s, { type: 'parseScriptDraftAsBlueprint' })
  assert.equal(s.blueprintBase, 'draft', '以草稿解析后蓝图基准 = 草稿')
  const t = viewStateMachine(s, { type: 'saveScriptOk', text: 'saved-1' })
  assert.equal(t.effects.length, 0, '脚本保存无需编辑器覆写（编辑器已持有该文本）')
  s = t.state
  assert.equal(s.savedText, 'saved-1')
  assert.equal(s.scriptDirty, false)
  assert.equal(s.blueprintBase, 'saved', '保存后蓝图基准复位为已保存版本（过期即重载）')
  assert.equal(scriptDraftPending(s), false)
})

test('saveScriptFail：状态原样保留（草稿不丢，DoD 无脏丢失；返回同一引用）', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'editScript', text: 'draft-1' })
  const before = s
  const t = viewStateMachine(s, { type: 'saveScriptFail' })
  assert.ok(t.state === before, '失败转换为恒等（不产生新状态对象）')
  assert.equal(t.effects.length, 0)
  assert.equal(before.scriptDirty, true)
})

test('saveBlueprintOk：保存者胜——基线推进为 codegen 文本 + 脚本草稿一并失效 + 编辑器重载 effect', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'editScript', text: '滞留的脚本草稿' })
  s = send(s, { type: 'switchView', view: 'blueprint' })
  s = send(s, { type: 'editBlueprint' })
  assert.equal(s.blueprintDirty, true)
  const t = viewStateMachine(s, { type: 'saveBlueprintOk', text: '// codegen 覆盖写盘\n' })
  assert.deepEqual(t.effects, [{ type: 'setScriptConfirmed', text: '// codegen 覆盖写盘\n' }])
  s = t.state
  assert.equal(s.savedText, '// codegen 覆盖写盘\n')
  assert.equal(s.blueprintDirty, false)
  assert.equal(s.scriptDirty, false, '保存者胜：滞留的脚本草稿被蓝图写盘覆盖（编辑器将重载）')
  assert.equal(s.blueprintBase, 'saved')
})

test('saveBlueprintFail：蓝图修改保留（DoD 无脏丢失），切回脚本视图横幅可见', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'switchView', view: 'blueprint' })
  s = send(s, { type: 'editBlueprint' })
  const before = s
  const t = viewStateMachine(s, { type: 'saveBlueprintFail' })
  assert.ok(t.state === before, '失败转换为恒等')
  const back = send(before, { type: 'switchView', view: 'script' })
  assert.equal(blueprintDirtyPending(back), true, '脚本视图显示「蓝图已修改（未保存）」横幅')
})

test('以草稿解析 / 放弃草稿：蓝图基准切换 + 编辑器重置 effect（放弃后草稿清零）', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'editScript', text: 'draft-1' })
  s = send(s, { type: 'switchView', view: 'blueprint' })
  assert.equal(scriptDraftPending(s), true)
  s = send(s, { type: 'parseScriptDraftAsBlueprint' })
  assert.equal(s.blueprintBase, 'draft')
  assert.equal(s.scriptDirty, true, '以草稿解析不改变草稿未保存的事实')
  assert.equal(scriptDraftPending(s), false, '基准已是草稿 → 提示条撤下')
  // 放弃草稿：编辑器重置为已保存版本（effect）+ 草稿清零 + 基准复位
  const t = viewStateMachine(s, { type: 'discardScriptDraft' })
  assert.deepEqual(t.effects, [{ type: 'setScriptConfirmed', text: SAVED }])
  assert.equal(t.state.scriptDirty, false)
  assert.equal(t.state.blueprintBase, 'saved')
})

test('应用并覆盖脚本 / 丢弃蓝图修改：蓝图修改移交为脚本草稿（setScriptDraft effect）', () => {
  let s = initSyncState(SAVED)
  s = send(s, { type: 'switchView', view: 'blueprint' })
  s = send(s, { type: 'editBlueprint' })
  s = send(s, { type: 'switchView', view: 'script' })
  assert.equal(blueprintDirtyPending(s), true)
  const t = viewStateMachine(s, { type: 'applyBlueprintToScript', text: '// codegen 写回\n' })
  assert.deepEqual(t.effects, [{ type: 'setScriptDraft', text: '// codegen 写回\n' }])
  s = t.state
  assert.equal(s.blueprintDirty, false, '蓝图侧修改已移交')
  assert.equal(s.scriptDirty, true, '写回的是草稿（相对磁盘未保存 → 编辑器恢复脏态）')
  assert.equal(s.blueprintBase, 'saved')
  // 丢弃蓝图修改：蓝图基于已保存版本重新解析，脚本草稿不动
  let s2 = initSyncState(SAVED)
  s2 = send(s2, { type: 'switchView', view: 'blueprint' })
  s2 = send(s2, { type: 'editBlueprint' })
  s2 = send(s2, { type: 'switchView', view: 'script' })
  const t2 = viewStateMachine(s2, { type: 'discardBlueprintChanges' })
  assert.equal(t2.effects.length, 0, '丢弃无编辑器副作用')
  assert.equal(t2.state.blueprintDirty, false)
  assert.equal(t2.state.blueprintBase, 'saved')
})

test('双脏矩阵：脚本脏 × 蓝图脏 × 切换 × 保存 × 放弃（关键序无脏丢失）', () => {
  // 序 A：脚本脏 → 切蓝图 → 直接编辑蓝图（未处理横幅）→ 蓝图保存胜出，脚本草稿一并失效
  let s = initSyncState(SAVED)
  s = send(s, { type: 'editScript', text: '脚本草稿-A' })
  s = send(s, { type: 'switchView', view: 'blueprint' })
  assert.equal(scriptDraftPending(s), true, '双脏时蓝图侧仍显示脚本草稿提示（缺省按已保存渲染）')
  s = send(s, { type: 'editBlueprint' })
  s = send(s, { type: 'saveBlueprintOk', text: 'codegen-A' })
  assert.equal(s.scriptDirty, false)
  assert.equal(s.blueprintDirty, false)
  assert.equal(s.savedText, 'codegen-A')

  // 序 B：双脏 → 切回脚本 → 丢弃蓝图修改 → 脚本草稿仍在（可继续编辑 / 保存）
  let b = initSyncState(SAVED)
  b = send(b, { type: 'editScript', text: '脚本草稿-B' })
  b = send(b, { type: 'switchView', view: 'blueprint' })
  b = send(b, { type: 'editBlueprint' })
  b = send(b, { type: 'switchView', view: 'script' })
  assert.equal(blueprintDirtyPending(b), true)
  b = send(b, { type: 'discardBlueprintChanges' })
  assert.equal(b.blueprintDirty, false)
  assert.equal(b.scriptDirty, true, '丢弃蓝图不影响脚本草稿')
  b = send(b, { type: 'saveScriptOk', text: '脚本B-已保存' })
  assert.equal(b.scriptDirty, false)
  assert.equal(b.savedText, '脚本B-已保存')

  // 序 C：双脏 → 脚本保存胜出 → 蓝图基准复位（下次进入基于新 IR）
  let c = initSyncState(SAVED)
  c = send(c, { type: 'editScript', text: '脚本C草稿' })
  c = send(c, { type: 'switchView', view: 'blueprint' })
  c = send(c, { type: 'editBlueprint' })
  c = send(c, { type: 'switchView', view: 'script' })
  assert.equal(blueprintDirtyPending(c), true)
  assert.equal(c.scriptDirty, true, '脚本草稿不受蓝图编辑影响')
  c = send(c, { type: 'saveScriptOk', text: '脚本C-已保存' })
  assert.equal(c.blueprintDirty, true, '蓝图修改仍待处理（保存脚本不代蓝图做主）')
  assert.equal(c.blueprintBase, 'saved')
  c = send(c, { type: 'discardBlueprintChanges' })
  assert.equal(c.blueprintDirty, false)

  // 序 D：以草稿解析后再编辑蓝图 → 应用并覆盖脚本 → 再保存
  let d = initSyncState(SAVED)
  d = send(d, { type: 'editScript', text: '草稿D' })
  d = send(d, { type: 'switchView', view: 'blueprint' })
  d = send(d, { type: 'parseScriptDraftAsBlueprint' })
  d = send(d, { type: 'editBlueprint' })
  d = send(d, { type: 'switchView', view: 'script' })
  d = send(d, { type: 'applyBlueprintToScript', text: 'codegen-D' })
  assert.equal(d.scriptDirty, true)
  d = send(d, { type: 'saveScriptOk', text: 'codegen-D' })
  assert.equal(d.savedText, 'codegen-D')
  assert.equal(d.scriptDirty, false)
  assert.equal(d.blueprintDirty, false)
})

/* ============================================================
 * 2. DOM 冒烟（happy-dom：真实 BlueprintEditorPanel + parseScriptToIR）
 *
 * @/blueprint barrel 与 BPGraphCanvas 含 .css import，tsx/node 无法加载——
 * 测试内安装双通道 CSS shim（CJS require.extensions + ESM module.register
 * 数据 URL 钩子），使真实面板链路可加载（样式为空模块，不影响断言）。
 * ============================================================ */
import { Window } from 'happy-dom'

// CJS 通道 CSS shim（tsx 把 TS 编译为 require 链时命中）
;(Module as unknown as { _extensions: Record<string, (mod: { _compile(code: string, filename: string): void }, filename: string) => void> })._extensions['.css'] =
  function (mod, filename) {
    mod._compile('module.exports = {};', filename)
  }
// ESM 通道 CSS shim（ESM import 链命中；数据 URL 钩子，只拦截 .css）
registerLoaderHooks(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function load(url, context, nextLoad) {' +
        "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };" +
        '  return nextLoad(url, context);' +
        '}',
    ),
)

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
  'localStorage',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
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
// T5.4 调试观察 WS：测试环境置空（debug-ws.ts 的 typeof WebSocket === 'undefined' 守卫静默跳过，
// 不发起真实网络连接；否则 undici 原生 WS 与 happy-dom 的 Event 类型互不识别会崩进程）
setGlobal('WebSocket', undefined)

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ScriptTab } = await import('./ScriptTab')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 样本（含 @expose 变量 / @on('start') / @on 双参 UI 事件——T3.4 端到端锚点；零诊断形态） */
const SAMPLE_TS = `// log-viewer.ts —— 逻辑资产示意（受控 TS 子集）
@tool('日志查看器')
class LogViewer extends UILogic {
  @expose({ type: 'string', default: 'com.demo.app' })
  packageName: string

  @on('start')
  onStart(): void {
    ui.title.text = '日志分析'
  }

  @on('btnFetch', 'pressed')
  fetch(): void {
    ui.list.items = convert.androidLogParse(ui.input.value)
  }
}
`

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

function click(el: unknown): void {
  assert.ok(el, '待点击元素存在')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

/** 向目标派发 Ctrl+S keydown（绕开 happy-dom/DOM 库 Event 类型差异） */
function dispatchCtrlS(target: unknown): void {
  const ev = new dom.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
  ;(target as { dispatchEvent(e: unknown): boolean }).dispatchEvent(ev)
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await act(async () => {
      await sleep(10)
    })
  }
  return cond()
}

/** fetch 调用记录 + 可配置响应（GET / PUT 分离） */
interface FetchCall {
  method: string
  body: { path?: string; content?: string } | null
}
function installFetchMock(initial: { ok: boolean; content?: string; message?: string }) {
  const calls: FetchCall[] = []
  let getResponse = initial
  let putResponse: { ok: boolean; message?: string } = { ok: true }
  const original = globalThis.fetch
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: FetchCall['body'] = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as FetchCall['body']
      } catch {
        body = null
      }
    }
    calls.push({ method, body })
    if (method === 'GET') return Promise.resolve({ json: async () => getResponse } as Response)
    return Promise.resolve({ json: async () => putResponse } as Response)
  }) as typeof fetch
  return {
    calls,
    setGetResponse: (r: typeof getResponse) => {
      getResponse = r
    },
    setPutResponse: (r: { ok: boolean; message?: string }) => {
      putResponse = r
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const SCRIPT_TAB = tabIdOf('script', 'logic/log-viewer.ts')

function resetWorkspace(): void {
  resetEditorStore()
  resetShortcuts()
  useBlueprintStore.setState({ asset: null, assetPath: null, dirty: false })
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

function editorViewOf(): EditorView | null {
  const el = dom.document.querySelector('.script-editor .cm-editor')
  return el ? (EditorView.findFromDOM(el as unknown as HTMLElement) ?? null) : null
}

/** 挂载 ScriptTab 并等待脚本视图就绪（mock fetch） */
async function mountScriptTab(mock: ReturnType<typeof installFetchMock>) {
  resetWorkspace()
  const unmount = mount(createElement(ScriptTab, { assetPath: 'logic/log-viewer.ts', dirtyDebounceMs: 15 }))
  assert.ok(await waitFor(() => dom.document.querySelector('.cm-content') !== null), '加载后编辑器渲染')
  assert.equal(mock.calls[0]?.method, 'GET')
  return unmount
}

/** 点击 [蓝图] 切换条并等待真实面板画布出现 */
async function switchToBlueprint() {
  click(dom.document.querySelector('.script-view-switch-btn'))
  assert.ok(
    await waitFor(() => dom.document.querySelector('.react-flow') !== null),
    '蓝图视图渲染真实 BlueprintEditorPanel（ReactFlow 画布出现）',
  )
}

/** keymap 注册表 / 命令栈的键盘适配目标类型（HTMLElement | DOM Window；happy-dom Window 需转换） */
type KeyboardTarget = Parameters<typeof attachKeyboard>[0]

test('DOM：蓝图视图真渲染——My Blueprint 变量行 + @on 双参 → event.custom 节点', async () => {
  dom.document.body.innerHTML = ''
  const mock = installFetchMock({ ok: true, content: SAMPLE_TS })
  const unmount = await mountScriptTab(mock)
  try {
    await switchToBlueprint()
    // 画布节点渲染完成（ReactFlow 挂载后异步布局）
    assert.ok(await waitFor(() => dom.document.querySelectorAll('.react-flow__node').length >= 4), '画布节点渲染（≥4 个）')
    // parseScriptToIR 真实调用结果渲染进 My Blueprint（.bp-mb-row 变量行）
    const rows = [...dom.document.querySelectorAll('.bp-mb-row')] as unknown as HTMLElement[]
    assert.ok(rows.some((r) => r.textContent?.includes('packageName')), 'My Blueprint 变量列表出现 @expose 变量')
    assert.ok(
      rows.some((r) => r.querySelector('.bp-mb-exposed')?.getAttribute('aria-label') === '暴露 packageName'),
      '暴露勾选渲染',
    )
    // @on('btnFetch','pressed') → event.custom 节点（eventName=pressed）——面板收到的资产即解析结果
    const bpAsset = useBlueprintStore.getState().asset
    const evt = bpAsset?.graphs[bpAsset.entry]?.nodes.find((n) => n.type === 'event.custom')
    assert.ok(evt, 'event.custom 节点进入面板资产（双参 @on 的第二参）')
    assert.equal(evt?.params?.eventName, 'pressed', 'eventName=pressed')
    // event.start 节点标题在画布可见（spec.title「开始」）
    const canvasText = dom.document.querySelector('.react-flow')?.textContent ?? ''
    assert.ok(canvasText.includes('开始'), 'event.start 画布节点出现（标题「开始」）')
    // 干净资产：无脏冲突横幅、无降级提示
    assert.equal(dom.document.querySelector('.script-tab-syncbar'), null, '无脚本草稿 → 无同步横幅')
    const text = dom.document.body.textContent ?? ''
    assert.ok(!text.includes('降级'), '无降级提示（真渲染成功）')
  } finally {
    await unmount()
    mock.restore()
  }
})

test('DOM：蓝图保存（Ctrl+S）→ codegen 覆盖写盘 PUT → 脚本视图重载 CodeMirror（D3 魔法端到端）', async () => {
  dom.document.body.innerHTML = ''
  const mock = installFetchMock({ ok: true, content: SAMPLE_TS })
  const unmount = await mountScriptTab(mock)
  const unbindKeys = attachKeyboard(dom.window as unknown as KeyboardTarget)
  try {
    await switchToBlueprint()
    // 蓝图编辑：面板 store 改默认值（模拟用户在检视器编辑变量）
    act(() => {
      useBlueprintStore.getState().updateVariable('packageName', { default: 'com.changed.app' })
    })
    assert.equal(useBlueprintStore.getState().dirty, true, '面板编辑后 store 标脏')
    // Ctrl+S：keymap 注册表（蓝图视图内 file.save 由面板重绑定）→ 面板保存 → onSave → codegen → PUT
    dispatchCtrlS(dom.document.body)
    assert.ok(
      await waitFor(() => mock.calls.some((c) => c.method === 'PUT')),
      '蓝图保存发起 PUT /api/file',
    )
    const put = mock.calls.find((c) => c.method === 'PUT')
    assert.ok(put?.body?.content?.includes('@tool("日志查看器")'), '写盘内容 = codegenTS 生成的受控子集')
    assert.ok(put?.body?.content?.includes('com.changed.app'), '编辑后的 IR 进入生成文本（蓝图编辑 → 脚本资产）')
    assert.equal(put?.body?.path, 'D:/proj/demo/logic/log-viewer.ts', '覆盖写盘同一路径（.ts 源码）')
    // 保存完成信号：成功 toast（PUT 调用本身是异步链，toast 才代表协议链走完）
    assert.ok(
      await waitFor(() => (dom.document.body.textContent ?? '').includes('蓝图已保存')),
      '保存成功 toast（蓝图修改已写盘）',
    )
    assert.ok(await waitFor(() => !tabDirty()), '保存成功清脏')
    click((dom.document.querySelectorAll('.script-view-switch-btn')[1] ?? null) as unknown as HTMLButtonElement)
    assert.ok(await waitFor(() => dom.document.querySelector('.cm-content') !== null), '切回脚本视图')
    const doc = editorViewOf()?.state.doc.toString() ?? ''
    assert.ok(doc.includes('@tool("日志查看器")'), `脚本视图重载为 codegen 文本；doc=${JSON.stringify(doc.slice(0, 160))}`)
    assert.ok(doc.includes('com.changed.app'), '重载内容含蓝图编辑成果（保存者胜：写盘内容为准）')
    assert.ok(!doc.includes('com.demo.app'), '旧脚本内容被覆盖')
    const text = dom.document.body.textContent ?? ''
    assert.ok(text.includes('蓝图已保存'), '保存成功 toast')
  } finally {
    act(() => unbindKeys())
    await unmount()
    mock.restore()
    useWorkspaceStore.getState().clearDirty(SCRIPT_TAB)
  }
})

test('DOM：蓝图编辑未保存 → 切回脚本横幅 → 应用并覆盖脚本（codegen 写回草稿 + 恢复标脏）', async () => {
  dom.document.body.innerHTML = ''
  const mock = installFetchMock({ ok: true, content: SAMPLE_TS })
  const unmount = await mountScriptTab(mock)
  try {
    await switchToBlueprint()
    act(() => {
      useBlueprintStore.getState().updateVariable('packageName', { default: 'com.pending.app' })
    })
    // 切回脚本视图：同步协议横幅出现
    click((dom.document.querySelectorAll('.script-view-switch-btn')[1] ?? null) as unknown as HTMLButtonElement)
    assert.ok(await waitFor(() => dom.document.querySelector('.script-tab-syncbar') !== null), '蓝图脏横幅出现')
    assert.ok(
      (dom.document.body.textContent ?? '').includes('蓝图已修改（未保存）'),
      '横幅文案（应用并覆盖脚本 / 丢弃蓝图修改）',
    )
    assert.equal(mock.calls.some((c) => c.method === 'PUT'), false, '切换本身不写盘（保存者胜不做静默合并）')
    // 应用并覆盖脚本：codegen 写回编辑器草稿（未写盘）→ 编辑器内容更新 + 重新标脏
    const btns = [...dom.document.querySelectorAll('.script-tab-syncbtn')] as unknown as HTMLButtonElement[]
    const apply = btns.find((b) => b.textContent === '应用并覆盖脚本')
    click(apply ?? null)
    assert.ok(await waitFor(() => (editorViewOf()?.state.doc.toString() ?? '').includes('com.pending.app')), 'codegen 文本写回编辑器草稿')
    assert.ok(await waitFor(() => tabDirty()), '写回后编辑器恢复脏态（草稿待 Ctrl+S 确认）')
    assert.equal(mock.calls.some((c) => c.method === 'PUT'), false, '应用动作不写盘（仍需保存确认）')
    assert.ok(
      (dom.document.body.textContent ?? '').includes('蓝图修改已写回脚本草稿'),
      '操作结果 toast',
    )
  } finally {
    await unmount()
    mock.restore()
    useWorkspaceStore.getState().clearDirty(SCRIPT_TAB)
  }
})

test('DOM：脚本保存失败（PUT !ok）→ toast + 草稿保留 + 仍标脏（DoD 无脏丢失）', async () => {
  dom.document.body.innerHTML = ''
  const mock = installFetchMock({ ok: true, content: SAMPLE_TS })
  mock.setPutResponse({ ok: false, message: '409 冲突：远端较新' })
  const unmount = await mountScriptTab(mock)
  const unbindKeys = attachKeyboard(dom.window as unknown as KeyboardTarget)
  try {
    // 编辑草稿 → 防抖标脏
    const v = editorViewOf() as EditorView
    act(() => {
      v.dispatch({ changes: { from: 0, insert: '// draft-x\n' } })
    })
    assert.ok(await waitFor(() => tabDirty()), '编辑后标脏')
    const before = v.state.doc.toString()
    // Ctrl+S（keymap 注册表 → file.save）→ PUT 失败 → toast + 草稿原样 + 仍标脏
    dispatchCtrlS(dom.document.body)
    assert.ok(mock.calls.some((c) => c.method === 'PUT'), '保存发起 PUT')
    assert.ok(await waitFor(() => (dom.document.body.textContent ?? '').includes('保存失败')), '失败 toast')
    assert.equal(editorViewOf()?.state.doc.toString(), before, '草稿内容原样保留')
    assert.equal(tabDirty(), true, '仍标脏（不丢内容）')
  } finally {
    act(() => unbindKeys())
    await unmount()
    mock.restore()
    useWorkspaceStore.getState().clearDirty(SCRIPT_TAB)
  }
})
