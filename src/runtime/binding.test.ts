/**
 * 蓝图绑定 UI 节点 + 事件驱动运行测试（T2.6 · 任务卡单测清单）
 *
 * 1. 绑定发现：UIAsset 树中 logicAsset 节点收集 / 去重（props 位与顶层位双支持）
 * 2. UiHandle：find / read / write（happy-dom：renderUI 渲染后操作 DOM 断言；
 *    text/value/checked 直改 DOM + 内存同步，items 走 updateUI 增量，缺失回落 props）
 * 3. 事件路由：BindingRunner + 真解释器（builtinSpecMap）——UI 内建事件 → rt.emit →
 *    蓝图 event.custom 链执行（ui.setTitle 改 DOM）；start 事件 + print 走控制台通道
 * 4. 多蓝图 hub 转发：A 蓝图 event.send → 中央 hub → B 蓝图 event.listen 收到；
 *    转发回声不二次转发
 * 5. logicRef 选项列表构建（/api/tree 树 → .bp.json 列表，容错）
 * 6. 空蓝图模板结构合法（deserializeIR 通过）
 *
 * 运行：npx tsx --test src/runtime/binding.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { UINode, UIAsset } from '../ir/types'
import type { IRAsset } from '../ir/types'
import type { UIRenderHandle } from './render/render'

/* ── happy-dom 环境注入（必须先于依赖 DOM 的模块求值）────────────── */
const win = new Window()
const doc = win.document
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = doc

/* ── 动态导入（依赖已注入的全局）────────────────────────────── */
const {
  collectBoundNodes,
  resolveBoundPath,
  emptyBlueprintAsset,
  buildLogicAssetOptions,
  makeUiHandle,
  BlueprintEventHub,
  hubDebugSink,
  BindingRunner,
} = await import('./binding')
const { renderUI, updateUI } = await import('./render/render')
const { createRuntime } = await import('./interpreter')
const { editorSpecMap } = await import('../blueprint/my-blueprint/graph-op-specs')
const { deserializeIR } = await import('../ir/validate')

/* ── 公共工具 ─────────────────────────────────────────────── */

/** 构造 UINode（缺省 transform / theme / children，测试用） */
function mkNode(
  id: string,
  name: string,
  type: string,
  props: Record<string, unknown> = {},
  children: UINode[] = [],
): UINode {
  return {
    id,
    name,
    type,
    transform: { position: { x: 0, y: 0 }, size: { w: 120, h: 32 }, rotation: 0 },
    theme: {},
    props,
    events: [],
    children,
  }
}

function mkAsset(root: UINode): UIAsset {
  return { version: 2, name: '测试 UI', root }
}

/** mock fetch：按完整 URL 查路由（/api/file 契约） */
function mockFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const body = routes[url]
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ ok: false, message: `文件不存在：${url}` }),
      } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
}

/** 轮询等待条件成立（解释器事件队列 / 异步链提交均为异步） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 渲染 UI 资产并挂载到 body（返回句柄；用例结束自行 destroy）。doc 双跳桥接同 runtime.test.ts */
function renderToBody(asset: UIAsset): UIRenderHandle {
  const handle = renderUI(asset, { mode: 'runtime', onEvent: () => {} })
  ;(doc as unknown as Document).body.appendChild(handle.el)
  return handle
}

/** 按 data-uid 取节点元素 */
function elOf(handle: UIRenderHandle, uid: string): HTMLElement | null {
  return handle.el.querySelector<HTMLElement>(`[data-uid="${uid}"]`)
}

/* ══ 1. 绑定发现：收集 + 去重 ═══════════════════════════════ */

describe('绑定发现（collectBoundNodes / resolveBoundPath）', () => {
  test('props 位优先、顶层位回落、空串视为未绑定、同路径多节点去重分组', () => {
    const btn = mkNode('b1', 'btnGo', 'button')
    btn.logicAsset = 'logic/other.bp.json' // 顶层位（模板形态）
    const list = mkNode('l1', 'list', 'list', { logicAsset: 'logic/main.bp.json' }) // props 位（检视器形态）
    const lbl = mkNode('lb', 'lbl', 'label', { logicAsset: 'logic/main.bp.json' }) // 同路径 → 与 list 归组
    const cleared = mkNode('x1', 'x', 'label', { logicAsset: '' }) // 空串 = 未绑定
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [btn, list, mkNode('p', 'panel', 'panel', {}, [lbl, cleared])]))

    assert.equal(resolveBoundPath(cleared), undefined, 'props 空串且无顶层 = 未绑定')
    assert.equal(resolveBoundPath(list), 'logic/main.bp.json', 'props 位优先')
    assert.equal(resolveBoundPath(btn), 'logic/other.bp.json', '无 props 位回落顶层')

    const bindings = collectBoundNodes(asset)
    assert.deepEqual(
      bindings.map((b) => b.path),
      ['logic/other.bp.json', 'logic/main.bp.json'],
      '按路径首次出现顺序去重',
    )
    assert.deepEqual(
      bindings.map((b) => b.nodes.map((n) => n.id)),
      [['b1'], ['l1', 'lb']],
      '同路径多节点归入同组，未绑定节点不收集',
    )
  })

  test('无绑定的资产返回空数组', () => {
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [mkNode('a', 'a', 'label')]))
    assert.deepEqual(collectBoundNodes(asset), [])
  })
})

/* ══ 2. UiHandle：find / read / write ═══════════════════════ */

describe('UiHandle（ADR-005：ui 访问器 = 绑定节点子树）', () => {
  test('find / read：实时 DOM 优先，元素缺失或属性不可映射回落 props；find 不存在返回 null', () => {
    const lbl = mkNode('lb', 'label1', 'label', { text: '旧文本' })
    const ed = mkNode('ed', 'ed1', 'lineEdit', { text: 'abc' })
    const ghost = mkNode('gh', 'ghost', 'label', { text: '不在渲染树内' })
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [lbl, ed]))
    const handle = renderToBody(asset)

    const missing: string[] = []
    const ui = makeUiHandle({
      scopes: [lbl, ed, ghost], // ghost 不在渲染树内 → 元素缺失回落 props
      getEl: (node) => elOf(handle, node.id),
      refresh: () => updateUI(handle, asset),
      onMissing: (m) => missing.push(m),
    })

    // find：轻量节点对象（name / type / props 活引用）；不存在 → null
    const found = ui.find('label1') as { name: string; type: string; props: Record<string, unknown> }
    assert.deepEqual({ name: found.name, type: found.type }, { name: 'label1', type: 'label' })
    assert.equal(found.props, lbl.props, 'props 为活引用')
    assert.equal(ui.find('nope'), null, '未找到返回 null')

    // read text：label 无控件 → textContent（实时 DOM）
    assert.equal(ui.read('label1', 'text'), '旧文本')
    elOf(handle, 'lb')!.textContent = '手工改'
    assert.equal(ui.read('label1', 'text'), '手工改', 'read 实时 DOM 优先')

    // read text：输入控件 → 实时输入值（props 仍是旧值）
    const input = elOf(handle, 'ed') as unknown as HTMLInputElement
    assert.equal(input.tagName, 'INPUT')
    input.value = '用户输入'
    assert.equal(ui.read('ed1', 'text'), '用户输入')
    assert.equal(ui.read('ed1', 'value'), '用户输入', 'value 读控件实时值')

    // read：不可 DOM 映射的属性 → 回落 props；元素缺失 → 回落 props
    assert.equal(ui.read('label1', 'title'), '', 'title 未设置回落（props 无该键 → undefined 语义，这里显式给空）')
    assert.equal(ui.read('ghost', 'text'), '不在渲染树内', '元素缺失回落 props')
    assert.equal(missing.length, 0, 'read 命中不触发 onMissing')

    // read / find：不存在的名字 → onMissing 提示（中文）
    assert.equal(ui.read('nope', 'text'), undefined)
    assert.ok(missing.some((m) => m.includes('nope')), 'onMissing 收到中文提示')

    handle.destroy()
  })

  test('write：text/value/checked/visible 直改 DOM 并同步内存 props', () => {
    const lbl = mkNode('lb', 'label1', 'label', { text: '旧文本' })
    const cb = mkNode('cb', 'cb1', 'checkBox', { text: '选项', checked: false })
    const ed = mkNode('ed', 'ed1', 'lineEdit', { text: 'abc' })
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [lbl, cb, ed]))
    const handle = renderToBody(asset)

    const missing: string[] = []
    const ui = makeUiHandle({
      scopes: [lbl, cb, ed],
      getEl: (node) => elOf(handle, node.id),
      refresh: () => updateUI(handle, asset),
      onMissing: (m) => missing.push(m),
    })

    // write text（label）：DOM textContent 更新 + 内存 props 同步（后续 updateUI 不回退）
    ui.write('label1', 'text', '新文本')
    assert.equal(elOf(handle, 'lb')!.textContent, '新文本')
    assert.equal(lbl.props.text, '新文本')
    updateUI(handle, asset)
    assert.equal(elOf(handle, 'lb')!.textContent, '新文本', '内存同步后全量重放不回退')

    // write checked（checkBox）：子控件勾选 + props 同步；read 回读实时值
    ui.write('cb1', 'checked', true)
    const box = elOf(handle, 'cb')!.querySelector<HTMLInputElement>('input[type=checkbox]')!
    assert.equal(box.checked, true)
    assert.equal(cb.props.checked, true)
    assert.equal(ui.read('cb1', 'checked'), true)

    // write value（lineEdit）：输入控件直改（非焦点态立即生效）+ props 同步
    ui.write('ed1', 'value', '蓝图写入')
    const input = elOf(handle, 'ed') as unknown as HTMLInputElement
    assert.equal(input.value, '蓝图写入')
    assert.equal(ed.props.value, '蓝图写入')
    assert.equal(ui.read('ed1', 'value'), '蓝图写入')

    // write visible：直改 display + 渲染标记 + props
    ui.write('label1', 'visible', false)
    assert.equal(elOf(handle, 'lb')!.style.display, 'none')
    assert.equal(elOf(handle, 'lb')!.dataset.visible, 'false')
    assert.equal(lbl.props.visible, false)
    assert.equal(ui.read('label1', 'visible'), false)
    ui.write('label1', 'visible', true)
    assert.equal(elOf(handle, 'lb')!.style.display, '')

    handle.destroy()
  })

  test('write items（结构型）：改内存 props + updateUI 增量重建 DOM 行；焦点让步', () => {
    const ed = mkNode('ed', 'ed1', 'lineEdit', { text: '' })
    const ls = mkNode('ls', 'list1', 'list', { items: '[]' })
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [ls, ed]))
    const handle = renderToBody(asset)

    const ui = makeUiHandle({
      scopes: [ls, ed],
      getEl: (node) => elOf(handle, node.id),
      refresh: () => updateUI(handle, asset),
      onMissing: () => {},
    })

    const rows = [
      { level: 'INFO', message: '就绪' },
      { level: 'ERROR', message: '崩溃' },
      { level: 'WARN', message: '告警' },
    ]
    ui.write('list1', 'items', rows)
    assert.equal(ls.props.items, rows, 'items 存内存 props（数组本体）')
    const body = elOf(handle, 'ls')!.querySelector<HTMLElement>('.bps-lbody')!
    assert.equal(body.querySelectorAll('.bps-lrow').length, 3, 'updateUI 增量重建出 3 行')

    // 结构型属性 read：经 props 回读
    assert.equal(ui.read('list1', 'items'), rows)

    // 焦点让步：控件聚焦中 write 不覆盖实时输入（props 仍同步，失焦后 update 应用）
    const input = elOf(handle, 'ed') as unknown as HTMLInputElement
    input.focus()
    input.value = '正在输入'
    ui.write('ed1', 'value', '蓝图写入')
    assert.equal(input.value, '正在输入', '聚焦中不覆盖')
    assert.equal(ed.props.value, '蓝图写入', '内存 props 已同步')
    input.blur()
    updateUI(handle, asset)
    assert.equal(input.value, '蓝图写入', '失焦后重放应用')

    handle.destroy()
  })

  test('write 不存在的节点：onMissing 中文提示，不抛错', () => {
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [mkNode('a', 'a', 'label')]))
    const handle = renderToBody(asset)
    const missing: string[] = []
    const ui = makeUiHandle({
      scopes: [asset.root],
      getEl: (node) => elOf(handle, node.id),
      refresh: () => updateUI(handle, asset),
      onMissing: (m) => missing.push(m),
    })
    assert.doesNotThrow(() => ui.write('ghost', 'text', 'x'))
    assert.ok(missing.some((m) => m.includes('ghost') && m.includes('text')), '提示含节点名与属性')
    handle.destroy()
  })
})

/* ══ 3. 事件路由：runner + 真解释器 ═════════════════════════ */

describe('事件驱动运行（BindingRunner + IR 解释器真实例）', () => {
  test('内建事件 pressed → event.custom 链执行（ui.setTitle 改 DOM）；start 触发 + print 进控制台', async () => {
    const bp: IRAsset = {
      version: 2,
      name: '按钮逻辑',
      entry: 'bind',
      graphs: {
        bind: {
          nodes: [
            { id: 'e_start', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
            { id: 'p_hi', type: 'system.print', params: {}, pinDefaults: { value: '蓝图已启动' }, position: { x: 200, y: 0 } },
            { id: 'e_pressed', type: 'event.custom', params: { eventName: 'pressed' }, pinDefaults: {}, position: { x: 0, y: 200 } },
            { id: 's_title', type: 'ui.setTitle', params: {}, pinDefaults: { name: 'title', attr: 'text', value: '已点击' }, position: { x: 200, y: 200 } },
          ],
          edges: [
            { id: 'ed1', kind: 'exec', from: { node: 'e_start', pin: 'exec' }, to: { node: 'p_hi', pin: 'exec' } },
            { id: 'ed2', kind: 'exec', from: { node: 'e_pressed', pin: 'exec' }, to: { node: 's_title', pin: 'exec' } },
          ],
        },
      },
      variables: [],
      events: [],
      snippets: [],
      layout: {},
    }
    const btn = mkNode('btn', 'btnGo', 'button', { text: '点我' })
    const title = mkNode('ttl', 'title', 'label', { text: '初始' })
    // 绑定在根容器上（PLAN §4.2：ui 访问器 = 绑定节点子树根）→ 子树内 btnGo / title 均可达
    const asset = mkAsset(mkNode('root', 'root', 'vbox', { logicAsset: 'logic/main.bp.json' }, [btn, title]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const fetchCalls: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockFetch(
        {
          [`/api/file?path=${encodeURIComponent('演示项目/logic/main.bp.json')}`]: {
            ok: true,
            content: JSON.stringify(bp),
          },
        },
        fetchCalls,
      ),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    // 蓝图加载：一次 fetch、控制台收到加载行与 start 链的 print
    assert.deepEqual(fetchCalls, [`/api/file?path=${encodeURIComponent('演示项目/logic/main.bp.json')}`])
    await waitFor(() => lines.some((l) => l.includes('[绑定] 已加载 logic/main.bp.json')), '绑定加载行')
    await waitFor(() => lines.some((l) => l.includes('蓝图已启动')), 'start 事件链 print')
    assert.ok(lines.every((l) => l.includes('[蓝图:按钮逻辑]') || l.includes('[绑定]')), 'print 走控制台通道并带蓝图前缀')

    // 事件路由：renderUI onEvent 形态 → 持有该节点的 runtime → event.custom(params.eventName=pressed)
    runner.routeEvent({ nodeName: 'btnGo', nodeType: 'button', event: 'pressed' })
    await waitFor(() => elOf(handle, 'ttl')!.textContent === '已点击', 'ui.setTitle 经 UiHandle 直改 DOM')
    assert.equal(title.props.text, '已点击', '内存 props 同步')

    // 不属于任何绑定子树的节点：静默忽略（不抛错、无副作用）
    runner.routeEvent({ nodeName: 'ghost', nodeType: 'label', event: 'pressed' })
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(errors.length === 0, `无错误上报（实际：${errors.join('|')}）`)

    runner.stop()
    handle.destroy()
  })

  test('蓝图加载失败：打印中文错误行，不阻断其它绑定与运行', async () => {
    const good: IRAsset = {
      version: 2,
      name: '好蓝图',
      entry: 'bind',
      graphs: {
        bind: {
          nodes: [
            { id: 'e', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
            { id: 'p', type: 'system.print', params: {}, pinDefaults: { value: 'ok' }, position: { x: 100, y: 0 } },
          ],
          edges: [{ id: 'ed', kind: 'exec', from: { node: 'e', pin: 'exec' }, to: { node: 'p', pin: 'exec' } }],
        },
      },
      variables: [],
      events: [],
      snippets: [],
      layout: {},
    }
    const a = mkNode('a', 'a1', 'label')
    a.logicAsset = 'logic/broken.bp.json'
    const b = mkNode('b', 'b1', 'label')
    b.logicAsset = 'logic/good.bp.json'
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [a, b]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockFetch({
        [`/api/file?path=${encodeURIComponent('演示项目/logic/good.bp.json')}`]: {
          ok: true,
          content: JSON.stringify(good),
        },
      }),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(() => lines.some((l) => l.includes('加载失败：logic/broken.bp.json')), '失败行')
    await waitFor(() => lines.some((l) => l.includes('已加载 logic/good.bp.json')), '好蓝图照常加载')
    await waitFor(() => lines.some((l) => l.includes('ok')), '好蓝图 start 链执行')
    assert.ok(errors.some((m) => m.includes('logic/broken.bp.json')), '错误上报给控制台错误通道')
    runner.stop()
    handle.destroy()
  })
})

/* ══ 4. 多蓝图 hub 转发 ═════════════════════════════════════ */

describe('跨蓝图事件广播（BlueprintEventHub）', () => {
  test('A 蓝图 event.send → hub 转发 → B 蓝图 event.listen 收到；回声不二次转发', async () => {
    const mkAssetIR = (name: string, nodes: IRAsset['graphs']['bind']['nodes'], edges: IRAsset['graphs']['bind']['edges']): IRAsset => ({
      version: 2,
      name,
      entry: 'bind',
      graphs: { bind: { nodes, edges } },
      variables: [],
      events: [],
      snippets: [],
      layout: {},
    })

    // A：start → 发送事件 ping（参数 from='A'）；并监听 ping（同资产自路由应收到一次）
    const assetA = mkAssetIR(
      '蓝图A',
      [
        { id: 'e', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
        { id: 'send', type: 'event.send', params: {}, pinDefaults: { eventName: 'ping', args: { from: 'A' } }, position: { x: 100, y: 0 } },
        { id: 'listen', type: 'event.listen', params: {}, pinDefaults: { eventName: 'ping' }, position: { x: 0, y: 200 } },
        { id: 'print', type: 'system.print', params: {}, pinDefaults: {}, position: { x: 100, y: 200 } },
      ],
      [
        { id: 'ed1', kind: 'exec', from: { node: 'e', pin: 'exec' }, to: { node: 'send', pin: 'exec' } },
        { id: 'ed2', kind: 'exec', from: { node: 'listen', pin: 'exec' }, to: { node: 'print', pin: 'exec' } },
        { id: 'ed3', kind: 'data', from: { node: 'listen', pin: 'args' }, to: { node: 'print', pin: 'value' } },
      ],
    )
    // B：监听 ping → 打印参数
    const assetB = mkAssetIR(
      '蓝图B',
      [
        { id: 'listen', type: 'event.listen', params: {}, pinDefaults: { eventName: 'ping' }, position: { x: 0, y: 0 } },
        { id: 'print', type: 'system.print', params: {}, pinDefaults: {}, position: { x: 100, y: 0 } },
      ],
      [
        { id: 'ed1', kind: 'exec', from: { node: 'listen', pin: 'exec' }, to: { node: 'print', pin: 'exec' } },
        { id: 'ed2', kind: 'data', from: { node: 'listen', pin: 'args' }, to: { node: 'print', pin: 'value' } },
      ],
    )

    const hub = new BlueprintEventHub()
    const printsA: unknown[][] = []
    const printsB: unknown[][] = []
    const specs = editorSpecMap()
    const rtA = createRuntime(assetA, specs, { onPrint: (...p) => printsA.push(p), onDebug: hubDebugSink('A', hub) })
    const rtB = createRuntime(assetB, specs, { onPrint: (...p) => printsB.push(p), onDebug: hubDebugSink('B', hub) })
    hub.add('A', rtA)
    hub.add('B', rtB)
    rtB.start() // B 也须启动：解释器对未启动实例的 emit 静默丢弃
    rtA.start()
    await waitFor(() => printsA.length > 0 && printsB.length > 0, '双向收到事件')
    assert.equal(printsA.length, 1, 'A 自路由恰一次（emit → 本资产 listen）')
    assert.equal(printsB.length, 1, 'B 经 hub 转发恰一次')
    const forwarded = printsB[0]![0] as Record<string, unknown>
    assert.equal(forwarded['from'], 'A', '事件参数原样透传')

    // 回声稳定：再等一拍，不出现二次转发导致的重复触发
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(printsA.length, 1, 'B dispatch 转发事件不回声给 A（HUB_ECHO_KEY 防自转发）')
    assert.equal(printsB.length, 1)

    // start 不广播：B 无 event.start 节点，若广播只会是 A 自己触发（已含在 printsA 之外无副作用）
    rtA.stop()
    rtB.stop()
  })
})

/* ══ 5. logicRef 选项列表构建 ═══════════════════════════════ */

describe('logicRef 选项列表（buildLogicAssetOptions）', () => {
  const tree = {
    ok: true,
    tree: {
      name: 'proj',
      path: 'proj',
      type: 'dir',
      children: [
        {
          name: 'logic',
          path: 'proj/logic',
          type: 'dir',
          children: [
            { name: 'main.bp.json', path: 'proj/logic/main.bp.json', type: 'file', ext: 'json', children: [] },
            { name: 'readme.md', path: 'proj/logic/readme.md', type: 'file', ext: 'md', children: [] },
            {
              name: 'sub',
              path: 'proj/logic/sub',
              type: 'dir',
              children: [
                { name: 'parser.bp.json', path: 'proj/logic/sub/parser.bp.json', type: 'file', ext: 'json', children: [] },
              ],
            },
          ],
        },
        {
          name: 'ui',
          path: 'proj/ui',
          type: 'dir',
          children: [
            { name: 'main.ui.json', path: 'proj/ui/main.ui.json', type: 'file', ext: 'json', children: [] },
            { name: 'fake.bp.json', path: 'proj/ui/fake.bp.json', type: 'file', ext: 'json', children: [] },
          ],
        },
      ],
    },
  }

  test('递归收集 .bp.json，value 为项目内相对路径；树外与其它扩展名不收', () => {
    const options = buildLogicAssetOptions(tree, 'proj')
    assert.deepEqual(
      options.map((o) => o.value),
      ['logic/main.bp.json', 'logic/sub/parser.bp.json'],
      'logic/ 递归收集（含子目录）；ui/ 下的 .bp.json 不在请求范围内自然不收',
    )
    assert.deepEqual(options[0], { value: 'logic/main.bp.json', label: 'logic/main.bp.json' })
  })

  test('容错：响应形状不合法 / 无 logic 目录返回空数组', () => {
    assert.deepEqual(buildLogicAssetOptions(null, 'proj'), [])
    assert.deepEqual(buildLogicAssetOptions({ ok: false }, 'proj'), [])
    assert.deepEqual(buildLogicAssetOptions({ ok: true, tree: { type: 'dir', path: 'proj', children: [] } }, 'proj'), [])
  })
})

/* ══ 6. 空蓝图模板结构合法 ══════════════════════════════════ */

describe('空蓝图模板（emptyBlueprintAsset）', () => {
  test('deserializeIR 通过：entry=bind 主图含 event.start，各表为空', () => {
    const bp = emptyBlueprintAsset('解析器')
    const ir = deserializeIR(JSON.stringify(bp))
    assert.equal(ir.version, 3)
    assert.equal(ir.name, '解析器')
    assert.equal(ir.entry, 'bind')
    assert.equal(ir.graphs['bind']!.nodes.length, 1)
    assert.equal(ir.graphs['bind']!.nodes[0]!.type, 'event.start')
    assert.deepEqual(ir.variables, [])
    assert.deepEqual(ir.events, [])
    assert.deepEqual(ir.snippets, [])
    assert.ok(ir.layout['bind'], 'bind 图有默认视图状态')
  })

  test('中文文件名与序列化往返无损', () => {
    const bp = emptyBlueprintAsset('日志 解析·v2')
    const round = deserializeIR(JSON.stringify(JSON.parse(JSON.stringify(bp))))
    assert.equal(round.name, '日志 解析·v2')
  })
})
