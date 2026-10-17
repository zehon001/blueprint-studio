/**
 * Blueprint Studio v2 —— 注解处理端到端测试（node:test，T3.4）
 *
 * 断言链（任务卡 T3.4 DoD，双向）：
 *  正向（脚本 → IR → 蓝图视图）：
 *   - TS 源码 @expose → parseScriptToIR → IRAsset.variables 含 exposed 变量
 *     （PLAN §9.2 示例：default / category / 裸 @expose / 注解 type 兜底）；
 *   - @on('start') → event.start 节点；@on('btnFetch','pressed')（双参 UI 事件，
 *     T2.6 语义取第二参）→ event.custom 节点（eventName=pressed）；
 *   - 蓝图视图（My Blueprint 真渲染，happy-dom）：变量列表出现 + 右键「插入
 *     Get/Set」可用（插入后主图出现 var.get/var.set 节点）。
 *  反向（蓝图 IR → codegen → 注解文本 → 重解析）：
 *   - IR 变量 exposed=true → codegenTS → @expose 注解在文本中（含 category）；
 *     重解析 exposed / category / default 保持（roundtrip 语义的注解面）；
 *   - 蓝图事件图（event.custom / event.start）→ @on 注解 → 重解析事件节点保持；
 *   - IR → codegen → parse → IR'：variables / events 深等（幂等）。
 *
 * MyBlueprint 为叶子组件（无 .css import，node:test 可直接挂载）；
 * BlueprintEditorPanel 整面板的 DOM 冒烟在 src/script/editor/sync.test.ts（CSS shim）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScriptToIR } from './parser-ts'
import { codegenTS } from './codegen-ts'
import { normalizeIR } from '../ir/validate'
import type { IRAsset, IRGraph, IRNode } from '../ir/types'

/* ============================================================
 * 样本（PLAN §9.2 受控子集示意，全注解形态）
 * ============================================================ */

const SAMPLE_TS = `// log-viewer.ts —— 逻辑资产示意（受控 TS 子集，零诊断形态）
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
    emit('loaded', 1)
  }
}
`

/** 主图节点查找 */
function nodeOf(asset: IRAsset, graph: string, type: string): IRNode | undefined {
  return (asset.graphs[graph] as IRGraph | undefined)?.nodes.find((n) => n.type === type)
}

/* ============================================================
 * 正向：脚本注解 → IR（T3.6 解析半边 + T3.4 补缺验证）
 * ============================================================ */

test('正向：§9.2 示例——@expose 变量 / @on start / @on 双参 → event.custom / 事件表', () => {
  const { asset, diagnostics } = parseScriptToIR(SAMPLE_TS)
  assert.deepEqual(diagnostics, [], '受控子集示例零诊断')
  // @expose → IR 变量（暴露 + 默认值）
  const pkg = asset.variables.find((v) => v.name === 'packageName')
  assert.ok(pkg, '变量 packageName 存在')
  assert.equal(pkg?.exposed, true, '@expose → exposed=true（蓝图自动生成 Get/Set 的依据）')
  assert.equal(pkg?.type, 'string')
  assert.equal(pkg?.default, 'com.demo.app', '初始化器缺省时取 @expose default 参数')
  // @on('start') → event.start 节点
  assert.ok(nodeOf(asset, 'main', 'event.start'), 'event.start 节点出现')
  // @on('btnFetch','pressed') 双参 → event.custom（eventName=第二参，T2.6 UI 事件语义）
  const evt = nodeOf(asset, 'main', 'event.custom')
  assert.ok(evt, 'event.custom 节点出现')
  assert.equal(evt?.params?.eventName, 'pressed', '双参 @on 的第二参为绑定事件名')
  // 事件表：@on 方法的事件名进入事件表（start 为内建不进；emit 是发送节点，不声明事件）
  assert.ok(asset.events.some((e) => e.name === 'pressed'), '@on 绑定的事件名进事件表')
  assert.ok(!asset.events.some((e) => e.name === 'start'), "内建事件 'start' 不进事件表")
  assert.ok(nodeOf(asset, 'main', 'event.send'), 'emit → event.send 节点出现')
})

test('正向补缺：裸 @expose（无括号）→ exposed=true（手工脚本常见形态）', () => {
  const code = `@tool('探查')
class T extends UILogic {
  @expose
  count: number = 3
}
`
  const { asset, diagnostics } = parseScriptToIR(code)
  assert.deepEqual(diagnostics, [])
  const v = asset.variables[0]
  assert.equal(v?.name, 'count')
  assert.equal(v?.exposed, true, '裸 @expose 生效（修复前丢失 exposed）')
  assert.equal(v?.type, 'float', 'TS number → float（契约定型，PLAN §5）')
  assert.equal(v?.default, 3, '初始化器优先')
  // 反向闭环：codegen 后重解析 exposed 保持
  const again = parseScriptToIR(codegenTS(asset)).asset
  assert.equal(again.variables[0]?.exposed, true, '裸 @expose 变量经 codegen 往返后仍 exposed')
})

test('正向补缺：@expose type 参数兜底（字段无 TS 类型注解时不再退化为 any）', () => {
  const code = `@tool('探查')
class T extends UILogic {
  @expose({ type: 'int', default: 5 })
  count = 0
}
`
  const { asset, diagnostics } = parseScriptToIR(code)
  assert.deepEqual(diagnostics, [])
  assert.equal(asset.variables[0]?.type, 'int', '注解 type 参数兜底（修复前为 any）')
  assert.equal(asset.variables[0]?.exposed, true)
  // TS 注解优先于注解 type 参数（优先级：@bps 注释 > TS 注解 > 注解 type > any）
  const both = parseScriptToIR(
    code.replace('count = 0', 'count: number = 0'),
  ).asset
  assert.equal(both.variables[0]?.type, 'float', 'TS 类型注解优先于注解 type 参数')
})

test('正向补缺：@expose category 解析（My Blueprint 分组显示依据）', () => {
  const code = `@tool('探查')
class T extends UILogic {
  @expose({ type: 'string', category: '配置' })
  packageName: string = ''
}
`
  const { asset } = parseScriptToIR(code)
  assert.equal(asset.variables[0]?.category, '配置', '@expose 带分类 → IRVariable.category')
})

/* ============================================================
 * 反向：蓝图 IR → codegen 注解文本 → 重解析（T3.5 实现锁定 + 端到端）
 * ============================================================ */

/** 反向样本：exposed 变量（含 category）+ 事件图（start / 双参 UI 事件） */
function reverseAsset(): IRAsset {
  return {
    version: 2,
    name: '日志查看器',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          { id: 'st', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'evt1', type: 'event.custom', params: { eventName: 'pressed' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'uiw1', type: 'ui.setValue', params: {}, pinDefaults: { name: 'title', value: '日志分析' }, position: { x: 0, y: 0 } },
          { id: 'uiw2', type: 'ui.listSetItems', params: {}, pinDefaults: { name: 'list', items: [] }, position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'x1', from: { node: 'st', pin: 'exec' }, to: { node: 'uiw1', pin: 'exec' }, kind: 'exec' },
          { id: 'x2', from: { node: 'evt1', pin: 'exec' }, to: { node: 'uiw2', pin: 'exec' }, kind: 'exec' },
        ],
      },
    },
    variables: [
      { name: 'packageName', type: 'string', default: 'com.demo', exposed: true, category: '配置' },
      { name: 'count', type: 'int', default: 0 },
    ],
    events: [{ name: 'pressed', params: [] }],
    snippets: [],
    layout: {},
  }
}

test('反向：IR 变量 exposed=true → codegen 文本含 @expose 注解（含 category）→ 重解析保持', () => {
  const code = codegenTS(reverseAsset())
  // @expose 注解在文本中（T3.5 形态锁定：type + default + category）
  assert.match(code, /@expose\(\{ type: "string", default: "com\.demo", category: "配置" \}\)/)
  assert.match(code, /packageName: string = "com\.demo";/)
  // 未暴露变量不生成 @expose
  assert.doesNotMatch(code, /@expose[\s\S]{0,40}count/, '非 exposed 变量不加注解')
  // 重解析：exposed / category / default 保持（注解面 roundtrip）
  const { asset, diagnostics } = parseScriptToIR(code)
  assert.deepEqual(diagnostics, [])
  const pkg = asset.variables.find((v) => v.name === 'packageName')
  assert.equal(pkg?.exposed, true)
  assert.equal(pkg?.category, '配置')
  assert.equal(pkg?.default, 'com.demo')
  const count = asset.variables.find((v) => v.name === 'count')
  assert.equal(count?.exposed, undefined, '非暴露变量往返后仍不暴露')
})

test('反向：蓝图事件图 → @on 注解 → 重解析事件节点保持（start / 双参 UI 事件）', () => {
  const code = codegenTS(reverseAsset())
  assert.match(code, /@on\('start'\)/, 'event.start → @on(\'start\')')
  assert.match(code, /@on\("pressed"\)/, 'event.custom（eventName=pressed）→ @on("pressed")——双参 @on 的文本形态')
  const { asset, diagnostics } = parseScriptToIR(code)
  assert.deepEqual(diagnostics, [])
  assert.ok(nodeOf(asset, 'main', 'event.start'), 'event.start 节点保持')
  const evt = nodeOf(asset, 'main', 'event.custom')
  assert.equal(evt?.params?.eventName, 'pressed', 'event.custom 事件名保持（eventName=pressed）')
})

test('反向幂等：IR → codegen → parse → IR′ 的 variables / events 深等', () => {
  const src = reverseAsset()
  const again = parseScriptToIR(codegenTS(src)).asset
  const a = normalizeIR(src)
  const b = normalizeIR(again)
  assert.deepEqual(b.variables, a.variables, '变量表往返无损（含 exposed / category / default）')
  const sortByName = (list: { name: string }[]) => [...list].sort((x, y) => (x.name < y.name ? -1 : 1))
  assert.deepEqual(sortByName(b.events), sortByName(a.events), '事件表往返无损（按名排序比较）')
  // 二次幂等（roundtrip 测试同口径）：对解析输出再跑一轮仍稳定
  const third = parseScriptToIR(codegenTS(again)).asset
  assert.deepEqual(normalizeIR(third).variables, b.variables, '二次 codegen 变量表稳定')
})

/* ============================================================
 * 蓝图视图 DOM 冒烟（My Blueprint 真渲染 + 插入 Get/Set 可用）
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
  'MutationObserver',
  'ResizeObserver',
  'Range',
  'getSelection',
  'Event',
  'CustomEvent',
  'EventTarget',
  'KeyboardEvent',
  'MouseEvent',
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
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MyBlueprint } = await import('../blueprint/my-blueprint/MyBlueprint')
const { useBlueprintStore } = await import('../blueprint/store/blueprint-store')
const { resetEditorStore, getDomainState } = await import('../shell/commands')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

void sleep

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(5)
  }
  return cond()
}

test('DOM：@expose → 蓝图 My Blueprint 变量列表 + 右键「插入 Get/Set」可用', async () => {
  // 正向解析真实脚本（parseScriptToIR 真实调用，非构造 IR）
  const { asset } = parseScriptToIR(SAMPLE_TS)
  resetEditorStore()
  useBlueprintStore.getState().openAsset(asset, 'logic/log-viewer.ts')

  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  act(() => {
    root.render(createElement(MyBlueprint, null))
  })
  try {
    await waitFor(() => dom.document.querySelector('.bp-mb-row') !== null)
    const rows = [...dom.document.querySelectorAll('.bp-mb-row')] as unknown as HTMLElement[]
    const pkgRow = rows.find((r) => r.textContent?.includes('packageName'))
    assert.ok(pkgRow, 'My Blueprint 变量列表出现 @expose 变量（packageName）')
    assert.ok(pkgRow?.classList.contains('bp-mb-row--exposed'), '暴露变量高亮样式（exposed）')
    assert.ok(
      pkgRow?.querySelector('.bp-mb-exposed')?.getAttribute('aria-label') === '暴露 packageName',
      '暴露勾选渲染',
    )
    // 右键变量行 → 上下文菜单（插入 Get / Set）
    act(() => {
      pkgRow?.dispatchEvent(
        new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }) as unknown as Event,
      )
    })
    assert.ok(await waitFor(() => dom.document.querySelector('.fs-menu') !== null), '行右键菜单出现')
    const menuBtns = [...dom.document.querySelectorAll('.fs-menu button')] as unknown as HTMLButtonElement[]
    const getBtn = menuBtns.find((b) => b.textContent === '插入 Get 节点')
    const setBtn = menuBtns.find((b) => b.textContent === '插入 Set 节点')
    assert.ok(getBtn && setBtn, '菜单含「插入 Get/Set 节点」')
    // 插入 Get → 主图出现 var.get（varName=packageName）
    act(() => {
      getBtn?.click()
    })
    await waitFor(() => dom.document.querySelector('.fs-menu') === null)
    const mainNodes = getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['main']?.nodes ?? []
    const getNode = mainNodes.find((n) => n.type === 'var.get')
    assert.ok(getNode, '插入 Get：主图出现 var.get 节点（@expose → 蓝图 Get/Set 语义闭环）')
    assert.equal(getNode?.params?.varName, 'packageName')
    // 再插入 Set
    act(() => {
      pkgRow?.dispatchEvent(
        new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }) as unknown as Event,
      )
    })
    await waitFor(() => dom.document.querySelector('.fs-menu') !== null)
    const setBtn2 = (
      [...dom.document.querySelectorAll('.fs-menu button')] as unknown as HTMLButtonElement[]
    ).find((b) => b.textContent === '插入 Set 节点')
    act(() => {
      setBtn2?.click()
    })
    await waitFor(() => dom.document.querySelector('.fs-menu') === null)
    const nodes2 = getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['main']?.nodes ?? []
    const setNode = nodes2.find((n) => n.type === 'var.set')
    assert.ok(setNode && setNode.params?.varName === 'packageName', '插入 Set：主图出现 var.set 节点')
    // 事件分节：@on 绑定的 pressed 应出现在事件列表（事件表由解析器按 @on 方法收集）
    const text = dom.document.body.textContent ?? ''
    assert.ok(text.includes('pressed'), '事件分节含 @on 绑定的事件名')
  } finally {
    act(() => {
      root.unmount()
      container.remove()
    })
  }
})
