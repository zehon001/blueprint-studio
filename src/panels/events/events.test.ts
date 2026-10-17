/**
 * 事件面板单元测试（T5.2 DoD · node:test + happy-dom）
 *
 * 覆盖（任务卡「单测」清单逐条）：
 *  1. 事件列表组装纯函数：内建+自定义合并（assembleEventRows）、logicAsset 缺失处理、
 *     .ts @on(...) 正则粗扫（scanScriptEvents：单参 / 双参取第二参 / @onEvent / 'start' 排除）
 *  2. 双击意图解析（resolveDoubleClick）：已有入口 → goto(graphName/nodeId)；缺失 →
 *     create-builtin / create-custom 参数；无 logicAsset → no-logic 提示；.ts → open-script
 *  3. event.custom 节点定位纯函数（findCustomEventNodes：params.eventName 匹配、
 *     title 命中已声明事件回退、entry 图优先）
 *  4. 组件冒烟（happy-dom）：选中节点渲染两节列表（绑定徽标 / 入口点标 / 参数签名）、
 *     双击触发真实 blueprint store action（goto 选中 / 内建自动建入口 / 自定义缺入口
 *     「一键创建」按钮）、无 logicAsset 提示 +「新建蓝图并挂载」按钮、未选节点资产级列表
 *  另含：桥接层（打开蓝图 tab / waitForBlueprintAsset 超时 / createBuiltInEntry 双命令
 *       可撤销 / createCustomEntry / mountLogicAssetOnSelection 双写与撤销）。
 *
 * 运行：npx tsx --test src/panels/events/events.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IRAsset, UIAsset, UINode } from '@/ir/types'
import { registerDomainState, resetEditorStore, undo, getDomainState } from '@/shell/commands'
import type { BlueprintDomainState } from '@/blueprint/store/blueprint-store'
import { useBlueprintStore, EMPTY_SELECTION } from '@/blueprint/store/blueprint-store'
import type { SceneTreeDomainState } from '@/ui-editor/store'
import { getSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import { tabIdOf, useWorkspaceStore } from '@/shell/workspace-store'
import {
  NO_ENTRY_MESSAGE,
  NO_LOGIC_MESSAGE,
  assembleEventRows,
  builtinEventRows,
  customEventRows,
  entryInsertPosition,
  findCustomEventNodes,
  findFirstCustomEventNode,
  resolveDoubleClick,
  scanScriptEvents,
  signatureOf,
  withEntryFlags,
  type EventRowModel,
  type LogicEventsInfo,
} from './events-model'
import {
  createBuiltInEntry,
  createCustomEntry,
  executeBlueprintIntent,
  gotoEventNode,
  mountLogicAssetOnSelection,
  openAndLocateEvent,
  waitForBlueprintAsset,
} from './blueprint-bridge'

/* ============================================================
 * 样本构造
 * ============================================================ */

const BP_PATH = 'logic/main.bp.json'

/** 样本 IR：parseLog 在键序上先于 bind——验证 entry 图优先的定位排序 */
function sampleIR(): IRAsset {
  return {
    version: 2,
    name: '主逻辑',
    entry: 'bind',
    graphs: {
      parseLog: {
        nodes: [
          { id: 'c_load_fn', type: 'event.custom', params: { eventName: 'loaded' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'c_title', type: 'event.custom', title: 'saved', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'c_other', type: 'event.custom', title: '未声明事件', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
      bind: {
        nodes: [
          { id: 'c_load', type: 'event.custom', params: { eventName: 'loaded' }, pinDefaults: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
    },
    variables: [],
    events: [
      { name: 'loaded', params: [{ name: 'count', type: 'float' }, { name: 'tag', type: 'string' }] },
      { name: 'saved', params: [] },
      { name: 'orphan', params: [] },
    ],
    snippets: [],
    layout: {},
  }
}

function bpLogic(ir: IRAsset = sampleIR()): LogicEventsInfo {
  return { path: BP_PATH, lang: 'bp', events: customEventRows(ir), ok: true, ir }
}

/** button UI 节点（schema 内建事件 pressed） */
function buttonNode(props: Record<string, unknown> = {}): UINode {
  return {
    id: 'btn1',
    type: 'button',
    name: '提交按钮',
    transform: { position: { x: 0, y: 0 }, size: { w: 96, h: 32 }, rotation: 0 },
    theme: {},
    props: { text: '提交', ...props },
    children: [],
  }
}

/* ============================================================
 * 1. 列表组装纯函数（DoD 单测 1）
 * ============================================================ */

test('signatureOf / builtinEventRows / customEventRows：三路行模型', () => {
  assert.equal(signatureOf([{ name: 'count', type: 'float' }, { name: 'tag', type: 'string' }]), '(count: float, tag: string)')
  assert.equal(signatureOf([]), '()')

  assert.deepEqual(builtinEventRows([{ name: 'pressed', label: '按下' }]), [
    { name: 'pressed', label: '按下', source: 'builtin' },
  ])
  assert.deepEqual(builtinEventRows(undefined), [])
  assert.deepEqual(builtinEventRows([]), [])

  const rows = customEventRows(sampleIR())
  assert.deepEqual(
    rows.map((r) => ({ name: r.name, source: r.source, signature: r.signature })),
    [
      { name: 'loaded', source: 'custom', signature: '(count: float, tag: string)' },
      { name: 'saved', source: 'custom', signature: '()' },
      { name: 'orphan', source: 'custom', signature: '()' },
    ],
  )
  assert.deepEqual(customEventRows(null), [])
})

test('scanScriptEvents：@on 单参 / 双参取第二参 / @onEvent / start 排除 / 去重', () => {
  const src = `
    @tool('日志查看器')
    class LogViewer extends UILogic {
      @on('start')
      onStart(): void {}

      @on('loaded')
      onLoad(count: number): void {}

      @on('btnFetch', 'pressed')
      async fetch(): Promise<void> {}

      @on(btnFilter, 'textChanged')
      onFilter(v: string): void {}

      @onEvent('refresh')
      onRefresh(): void {}

      @on('loaded')   // 重复：去重
      onLoad2(): void {}
    }
  `
  const rows = scanScriptEvents(src)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['loaded', 'pressed', 'textChanged', 'refresh'],
    "@on 单参 / 双参取第二参 / @onEvent；'start' 不进事件表；按出现序去重",
  )
  for (const r of rows) {
    assert.equal(r.source, 'custom')
    assert.equal(r.signature, '()', '粗扫拿不到形参签名')
  }
  // 非匹配形态：括号嵌套 / 无字符串参数
  assert.deepEqual(scanScriptEvents('const x = on("notDecorator"); @on(); @on(a, b)'), [])
})

test('assembleEventRows：内建+自定义合并 / logicAsset 缺失 / 加载失败降级', () => {
  const ir = sampleIR()
  // 有节点 + bp 资产：两节齐全，entry 徽标逐行补齐
  const merged = assembleEventRows(buttonNode(), bpLogic(ir))
  assert.deepEqual(merged.builtin.map((r) => r.name), ['pressed'])
  assert.deepEqual(merged.custom.map((r) => r.name), ['loaded', 'saved', 'orphan'])
  assert.equal(merged.builtin[0]!.entry, false, '内建事件无入口')
  assert.equal(merged.custom[0]!.entry, true, 'loaded 已有入口（bind:c_load）')
  assert.equal(merged.custom[1]!.entry, true, 'saved 有 title 回退入口')
  assert.equal(merged.custom[2]!.entry, false, 'orphan 无入口')

  // 无 logicAsset：custom 空，builtin 无徽标（entry = undefined）
  const noLogic = assembleEventRows(buttonNode(), null)
  assert.deepEqual(noLogic.custom, [])
  assert.equal(noLogic.builtin[0]!.name, 'pressed')
  assert.equal(noLogic.builtin[0]!.entry, undefined)

  // 加载失败（ok=false）：custom 空不显示半截列表
  const failed = assembleEventRows(buttonNode(), { path: BP_PATH, lang: 'bp', events: [], ok: false, message: '加载失败' })
  assert.deepEqual(failed.custom, [])

  // .ts 粗扫：custom 有行，entry 徽标不渲染（ir 缺失）
  const tsLogic: LogicEventsInfo = { path: 'logic/tool.ts', lang: 'ts', events: scanScriptEvents("@on('loaded')"), ok: true }
  const tsRows = assembleEventRows(buttonNode(), tsLogic)
  assert.deepEqual(tsRows.custom.map((r) => r.name), ['loaded'])
  assert.equal(tsRows.custom[0]!.entry, undefined)

  // 未知类型节点 / 未选节点：builtin 空
  assert.deepEqual(assembleEventRows({ ...buttonNode(), type: 'unknownType' }, bpLogic()).builtin, [])
  assert.deepEqual(assembleEventRows(null, bpLogic()).builtin, [])
})

/* ============================================================
 * 2. event.custom 定位纯函数（DoD 单测 3）
 * ============================================================ */

test('findCustomEventNodes：params.eventName 匹配 / title 回退 / entry 图优先', () => {
  const ir = sampleIR()
  // entry 图（bind）优先——parseLog 键序在前但结果以 bind 开头
  assert.deepEqual(findCustomEventNodes(ir, 'loaded'), [
    { graphName: 'bind', nodeId: 'c_load' },
    { graphName: 'parseLog', nodeId: 'c_load_fn' },
  ])
  assert.deepEqual(findFirstCustomEventNode(ir, 'loaded'), { graphName: 'bind', nodeId: 'c_load' })
  // title 命中「已声明事件名」回退（解释器 customEventName 同口径）
  assert.deepEqual(findCustomEventNodes(ir, 'saved'), [{ graphName: 'parseLog', nodeId: 'c_title' }])
  // title 未命中已声明事件 → 不算入口
  assert.deepEqual(findCustomEventNodes(ir, '未声明事件'), [])
  // 未定义事件
  assert.deepEqual(findCustomEventNodes(ir, 'nope'), [])

  // entry 图不在键序首位时也优先
  const ir2 = sampleIR()
  const entryGraph = ir2.graphs.bind!
  delete (ir2.graphs as Record<string, unknown>).bind
  ;(ir2.graphs as Record<string, unknown>).zBind = entryGraph
  assert.equal(findFirstCustomEventNode({ ...ir2, entry: 'zBind' }, 'loaded')!.graphName, 'zBind')
})

test('withEntryFlags：ir 缺失时徽标为 undefined（不渲染）', () => {
  const rows: EventRowModel[] = [{ name: 'loaded', label: 'loaded', source: 'custom' }]
  assert.deepEqual(withEntryFlags(rows, null), [{ name: 'loaded', label: 'loaded', source: 'custom', entry: undefined }])
  assert.equal(withEntryFlags(rows, sampleIR())[0]!.entry, true)
})

/* ============================================================
 * 3. 双击意图解析（DoD 单测 2）
 * ============================================================ */

test('resolveDoubleClick：无 logicAsset → no-logic 提示；bp 加载失败 → unsupported', () => {
  const row: EventRowModel = { name: 'pressed', label: '按下', source: 'builtin' }
  const intent = resolveDoubleClick(row, null)
  assert.equal(intent.kind, 'no-logic')
  assert.equal((intent as { message: string }).message, NO_LOGIC_MESSAGE)
  // .bp.json 资产加载失败（404 / 损坏）：不引导重复挂载，给出 unsupported + 原因透传
  const failed = resolveDoubleClick(row, { path: BP_PATH, lang: 'bp', events: [], ok: false, message: '加载失败' })
  assert.equal(failed.kind, 'unsupported')
  assert.match((failed as { message: string }).message, /加载失败/)
  // IR 缺失（ok=true 但未解析）同样 unsupported
  const noIr = resolveDoubleClick(row, { path: BP_PATH, lang: 'bp', events: [], ok: true })
  assert.equal(noIr.kind, 'unsupported')
})

test('resolveDoubleClick：.ts → open-script；.py / 未知 → unsupported', () => {
  const row: EventRowModel = { name: 'loaded', label: 'loaded', source: 'custom' }
  assert.deepEqual(resolveDoubleClick(row, { path: 'logic/tool.ts', lang: 'ts', events: [row], ok: true }), {
    kind: 'open-script',
    assetPath: 'logic/tool.ts',
  })
  assert.equal(resolveDoubleClick(row, { path: 'logic/t.py', lang: 'py', events: [], ok: false }).kind, 'unsupported')
  assert.equal(resolveDoubleClick(row, { path: 'logic/t.txt', lang: 'unknown', events: [], ok: false }).kind, 'unsupported')
})

test('resolveDoubleClick：已有入口 → goto；内建缺失 → create-builtin；自定义缺失 → create-custom', () => {
  const ir = sampleIR()
  const logic = bpLogic(ir)
  // 自定义 loaded 已有入口 → 跳转目标（entry 图优先）
  assert.deepEqual(resolveDoubleClick({ name: 'loaded', label: 'loaded', source: 'custom' }, logic), {
    kind: 'goto',
    graphName: 'bind',
    nodeId: 'c_load',
    eventName: 'loaded',
  })
  // 内建 pressed 无入口 → 自动创建参数
  assert.deepEqual(resolveDoubleClick({ name: 'pressed', label: '按下', source: 'builtin' }, logic), {
    kind: 'create-builtin',
    eventName: 'pressed',
  })
  // 自定义 orphan（已定义、无入口）→ 提示 + 一键创建参数
  assert.deepEqual(resolveDoubleClick({ name: 'orphan', label: 'orphan', source: 'custom' }, logic), {
    kind: 'create-custom',
    eventName: 'orphan',
  })
})

/* ============================================================
 * 4. 落点纯函数
 * ============================================================ */

test('entryInsertPosition：空图默认位；有图取最低点下方', () => {
  assert.deepEqual(entryInsertPosition(null), { x: 120, y: 200 })
  const ir = sampleIR()
  const pos = entryInsertPosition(ir)
  assert.equal(pos.x, 120)
  const maxY = Math.max(...Object.values(ir.graphs).flatMap((g) => g.nodes.map((n) => n.position.y)))
  assert.equal(pos.y, maxY + 80)
})

/* ============================================================
 * 5. 桥接层（真实 store action 执行端）
 * ============================================================ */

/** 重置编辑器 store 并装配 scene-tree / blueprint 两域 + 镜像（inspector.test 同款坑位规避） */
function setupStores(opts: { uiAsset?: UIAsset; selection?: string[]; withBlueprint?: boolean } = {}): IRAsset {
  const ir = sampleIR()
  resetEditorStore()
  getSceneTreeDomain() // 置位 ensureDomain 标记（避免后续 runCommand 报域未注册）
  registerDomainState<SceneTreeDomainState>('scene-tree', { asset: opts.uiAsset ?? null })
  registerDomainState<BlueprintDomainState>('blueprint', { asset: ir })
  useBlueprintStore.setState({
    asset: ir,
    assetPath: opts.withBlueprint === false ? null : BP_PATH,
    graphName: 'bind',
    selection: EMPTY_SELECTION,
    dirty: false,
  })
  useUIEditorStore.setState({
    selection: opts.selection ?? [],
    projectPath: 'P',
    assetPath: 'ui/main.ui.json',
    status: 'ready',
    message: '',
  })
  useWorkspaceStore.setState({
    currentProject: { name: 'P', path: 'P' },
    openTabs: [
      { id: tabIdOf('blueprint', BP_PATH), kind: 'blueprint', assetPath: BP_PATH, title: '蓝图编辑' },
    ],
    activeTabId: tabIdOf('blueprint', BP_PATH),
  })
  return ir
}

function bpDomainAsset(): IRAsset {
  return getDomainState<BlueprintDomainState>('blueprint').asset
}

test('gotoEventNode：切图 + 选中（blueprint store action）', () => {
  setupStores()
  gotoEventNode('parseLog', 'c_load_fn')
  const st = useBlueprintStore.getState()
  assert.equal(st.graphName, 'parseLog')
  assert.deepEqual(st.selection.nodeIds, ['c_load_fn'])
  // 目标图不存在：保持现状
  gotoEventNode('nope', 'x')
  assert.equal(useBlueprintStore.getState().graphName, 'parseLog')
})

test('createBuiltInEntry：addNode+setNodeParams 双命令建内建入口（撤销两步还原）', () => {
  const ir = setupStores()
  const before = ir.graphs.bind!.nodes.length
  const id = createBuiltInEntry('pressed')
  assert.ok(id, '创建成功并返回节点 id')
  const graph = bpDomainAsset().graphs.bind!
  const created = graph.nodes.find((n) => n.id === id)
  assert.ok(created, '入口节点落在 entry 图（bind）')
  assert.equal(created!.type, 'event.custom')
  assert.equal(created!.params.eventName, 'pressed')
  assert.deepEqual(useBlueprintStore.getState().selection.nodeIds, [id], '创建后选中新节点')
  // 撤销两步：先退 setNodeParams，再退 addNode
  undo()
  undo()
  const after = bpDomainAsset().graphs.bind!
  assert.equal(after.nodes.length, before, '两次撤销后节点数还原')
  assert.equal(after.nodes.find((n) => n.id === id), undefined)
})

test('createCustomEntry：insertEventNode 建自定义入口；未定义事件拒绝', () => {
  const ir = setupStores()
  const before = ir.graphs.bind!.nodes.length
  const id = createCustomEntry('loaded')
  assert.ok(id, '已定义事件创建成功')
  const created = bpDomainAsset().graphs.bind!.nodes.find((n) => n.id === id)
  assert.equal(created?.params.eventName, 'loaded')
  // 未在 asset.events 定义的事件：insertEventNode 拒绝（notify 错误、不建节点）
  const rejected = createCustomEntry('neverDefined')
  assert.equal(rejected, null)
  assert.equal(bpDomainAsset().graphs.bind!.nodes.length, before + 1, '拒绝时不新增节点')
})

test('waitForBlueprintAsset / openAndLocateEvent：已就绪立即通过；tab 未开自动打开', async () => {
  setupStores()
  // 已就绪：立即 resolve
  assert.equal(await waitForBlueprintAsset(BP_PATH, 100), true)
  let located = false
  assert.equal(await openAndLocateEvent(BP_PATH, () => { located = true }), null)
  assert.equal(located, true, '就绪后执行定位回调')

  // tab 未开：openAsset 建 tab 并激活；蓝图 store 已就绪（无面板环境直接命中判定）
  const ws = useWorkspaceStore.getState()
  ws.closeTab(tabIdOf('blueprint', BP_PATH))
  assert.equal(useWorkspaceStore.getState().openTabs.length, 0)
  located = false
  const err = await openAndLocateEvent(BP_PATH, () => { located = true })
  assert.equal(err, null)
  assert.equal(located, true)
  assert.equal(useWorkspaceStore.getState().activeTabId, tabIdOf('blueprint', BP_PATH), 'tab 已重新打开并激活')
})

test('openAndLocateEvent：蓝图永不就绪 → 超时报错；未开项目 → 提示', async () => {
  setupStores({ withBlueprint: false })
  const ws = useWorkspaceStore.getState()
  ws.closeTab(tabIdOf('blueprint', BP_PATH))
  useBlueprintStore.setState({ asset: null, assetPath: null })
  const err = await openAndLocateEvent(BP_PATH, () => {}, 60)
  assert.match(err ?? '', /超时/)
  // 未打开项目
  useWorkspaceStore.setState({ currentProject: null })
  const err2 = await openAndLocateEvent(BP_PATH, () => {}, 10)
  assert.match(err2 ?? '', /未打开项目/)
})

test('executeBlueprintIntent：goto 意图 → 打开蓝图并选中入口节点', async () => {
  setupStores()
  useBlueprintStore.setState({ graphName: 'parseLog' })
  const err = await executeBlueprintIntent({ kind: 'goto', graphName: 'bind', nodeId: 'c_load', eventName: 'loaded' }, BP_PATH)
  assert.equal(err, null)
  const st = useBlueprintStore.getState()
  assert.equal(st.graphName, 'bind')
  assert.deepEqual(st.selection.nodeIds, ['c_load'])
})

/* ============================================================
 * 6. 新建蓝图并挂载（fetch / prompt 打桩）
 * ============================================================ */

/** 内存文件系统（GET /api/file + PUT /api/file 打桩；返回 happy-dom 兼容响应） */
const fileStore = new Map<string, string>()
let fetchLog: { url: string; method: string }[] = []

function jsonResponse(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body }
}

function installFetch(): void {
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    fetchLog.push({ url, method })
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { path: string; content: string }
      fileStore.set(body.path, body.content)
      // 响应形状对齐真实服务端（server/index.ts PUT /api/file：{ ok, path, size }）
      return jsonResponse({ ok: true, path: body.path, size: body.content.length })
    }
    const path = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '').get('path') ?? ''
    const content = fileStore.get(path)
    if (content === undefined) return jsonResponse({ ok: false, message: `文件不存在：${path}` })
    return jsonResponse({ ok: true, content })
  }
}

function installPrompt(returnValue: string | null): void {
  ;(globalThis as unknown as { window: { prompt: unknown } }).window.prompt = () => returnValue
}

test('mountLogicAssetOnSelection：PUT 空蓝图 + runUICommand 双写 logicAsset（可撤销）', async () => {
  const node = buttonNode()
  const uiAsset: UIAsset = { version: 2, name: '测试 UI', root: node }
  setupStores({ uiAsset, selection: ['btn1'] })
  installFetch()
  installPrompt('logic/new.bp.json')
  fileStore.clear()
  fetchLog = []

  const err = await mountLogicAssetOnSelection('提交按钮')
  assert.equal(err, null)
  // PUT 请求落盘
  const put = fetchLog.find((f) => f.method === 'PUT')
  assert.ok(put, '发起了 PUT /api/file')
  assert.equal(put!.url, '/api/file')
  const saved = fileStore.get('P/logic/new.bp.json')
  assert.ok(saved && saved.includes('"entry": "bind"'), '空蓝图已写入（entry=bind 模板）')
  // 双写：顶层契约位 + props 显示位
  const bound = (getDomainState<SceneTreeDomainState>('scene-tree').asset as UIAsset).root
  assert.equal(bound.logicAsset, 'logic/new.bp.json')
  assert.equal(bound.props.logicAsset, 'logic/new.bp.json')
  // 撤销一次还原双写（props.logicAsset 原本不存在 → 键被移除为 undefined）
  undo()
  const reverted = (getDomainState<SceneTreeDomainState>('scene-tree').asset as UIAsset).root
  assert.equal(reverted.logicAsset, undefined)
  assert.equal(reverted.props.logicAsset, undefined)
})

test('mountLogicAssetOnSelection：非 .bp.json 文件名拒绝；未选中节点拒绝', async () => {
  const node = buttonNode()
  setupStores({ uiAsset: { version: 2, name: '测试 UI', root: node }, selection: ['btn1'] })
  installFetch()
  installPrompt('logic/new.ts')
  const err = await mountLogicAssetOnSelection('a')
  assert.match(err ?? '', /\.bp\.json/)
  // 未选中
  installPrompt('logic/new.bp.json')
  useUIEditorStore.setState({ selection: [] })
  const err2 = await mountLogicAssetOnSelection('a')
  assert.match(err2 ?? '', /选中/)
})

/* ============================================================
 * 7. 组件冒烟（happy-dom）
 * ============================================================ */
import { Window } from 'happy-dom'

const dom = new Window({ url: 'http://localhost/' })

function setGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: false })
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
  'FocusEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
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
const { EventsPanel, EventRowItem } = await import('./EventsPanel')

/** React 元素挂载到 happy-dom body（返回容器与卸载函数；用例内必须 await unmount） */
async function mountEl(node: ReturnType<typeof createElement>): Promise<{
  container: HTMLElement
  unmount: () => Promise<void>
}> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => {
    root.render(node)
  })
  return {
    container: container as unknown as HTMLElement,
    unmount: () =>
      act(async () => {
        root.unmount()
        container.remove()
      }),
  }
}

function clickEl(el: Element): void {
  el.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
}

function dblClickEl(el: Element): void {
  el.dispatchEvent(new dom.MouseEvent('dblclick', { bubbles: true }) as unknown as Event)
}

/** 等待微任务 / 定时器链Flush（act 内） */
async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function rowByName(name: string): HTMLElement | null {
  for (const row of dom.document.querySelectorAll('.ev-row')) {
    if (row.querySelector('.ev-row-name')?.textContent === name) return row as unknown as HTMLElement
  }
  return null
}

/** 组件态装配：UI 资产 + 选中节点 + 蓝图 store 就绪 + 文件系统打桩 */
function setupComponent(opts: { nodeProps?: Record<string, unknown>; selection?: string[] } = {}): void {
  const node = buttonNode({ logicAsset: BP_PATH, ...opts.nodeProps })
  const uiAsset: UIAsset = { version: 2, name: '测试 UI', root: node }
  setupStores({ uiAsset, selection: opts.selection ?? ['btn1'] })
  installFetch()
  fileStore.clear()
  fetchLog = []
  fileStore.set(`P/${BP_PATH}`, JSON.stringify(sampleIR()))
}

test('组件：选中节点渲染两节列表（绑定徽标 / 入口点标 / 参数签名）', async () => {
  setupComponent()
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    // 头部：节点名 + 绑定徽标
    assert.equal(dom.document.querySelector('.ev-title')?.textContent, '提交按钮')
    assert.equal(dom.document.querySelector('.ev-badge')?.textContent, '按钮')
    assert.equal(dom.document.querySelector('.ev-binding')?.textContent, '已绑定')

    // 内建事件节：pressed 行（无入口 → 点标暗）
    const sections = dom.document.querySelectorAll('.ev-section')
    assert.equal(sections.length, 2, '内建 + 自定义两节')
    const builtinRows = sections[0]!.querySelectorAll('.ev-row')
    assert.equal(builtinRows.length, 1)
    assert.equal(builtinRows[0]!.querySelector('.ev-row-label')?.textContent, '按下')
    assert.equal(builtinRows[0]!.querySelector('.ev-row-name')?.textContent, 'pressed')
    assert.ok(!builtinRows[0]!.querySelector('.ev-dot')!.classList.contains('ev-dot--on'), 'pressed 无入口点标')

    // 自定义事件节：loaded（有入口 + 签名）
    const loaded = rowByName('loaded')!
    assert.ok(loaded, 'loaded 行存在')
    assert.ok(loaded.querySelector('.ev-dot')!.classList.contains('ev-dot--on'), 'loaded 已有入口点标亮')
    assert.equal(loaded.querySelector('.ev-row-sig')?.textContent, '(count: float, tag: string)')
  } finally {
    await unmount()
  }
})

test('组件：双击内建事件（无入口）→ 自动创建 event.custom 入口', async () => {
  setupComponent()
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    const pressed = rowByName('pressed')!
    await act(async () => {
      dblClickEl(pressed)
      await new Promise((r) => setTimeout(r, 30))
    })
    const graph = bpDomainAsset().graphs.bind!
    const created = graph.nodes.find((n) => n.type === 'event.custom' && n.params.eventName === 'pressed')
    assert.ok(created, '双击后蓝图 bind 图出现 pressed 入口节点')
    assert.deepEqual(useBlueprintStore.getState().selection.nodeIds, [created!.id], '创建后蓝图选中新节点')
  } finally {
    await unmount()
  }
})

test('组件：双击自定义事件（有入口）→ 跳转蓝图并选中入口节点', async () => {
  setupComponent()
  useBlueprintStore.setState({ graphName: 'parseLog' })
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    await act(async () => {
      dblClickEl(rowByName('loaded')!)
      await new Promise((r) => setTimeout(r, 30))
    })
    const st = useBlueprintStore.getState()
    assert.equal(st.graphName, 'bind', '切回入口图')
    assert.deepEqual(st.selection.nodeIds, ['c_load'], '选中 event.custom 入口')
    assert.equal(dom.document.querySelector('.ev-notice'), null, '成功跳转无提示')
  } finally {
    await unmount()
  }
})

test('组件：双击自定义事件（已定义无入口）→ 提示 +「一键创建」按钮生效', async () => {
  setupComponent()
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    await act(async () => {
      dblClickEl(rowByName('orphan')!)
      await new Promise((r) => setTimeout(r, 30))
    })
    const notice = dom.document.querySelector('.ev-notice')
    assert.ok(notice, '缺入口出现提示')
    assert.match(notice!.textContent ?? '', new RegExp(NO_ENTRY_MESSAGE))
    const btn = notice!.querySelector('.ev-btn') as unknown as HTMLElement
    assert.equal(btn?.textContent, '一键创建')
    // 一键创建 → insertEventNode
    await act(async () => {
      clickEl(btn)
      await new Promise((r) => setTimeout(r, 30))
    })
    const graph = bpDomainAsset().graphs.bind!
    assert.ok(
      graph.nodes.some((n) => n.type === 'event.custom' && n.params.eventName === 'orphan'),
      '一键创建后入口节点落图',
    )
  } finally {
    await unmount()
  }
})

test('组件：无 logicAsset 双击 → 提示「先挂载」+「新建蓝图并挂载」按钮', async () => {
  setupComponent({ nodeProps: { logicAsset: '' } })
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    assert.equal(dom.document.querySelector('.ev-binding')?.textContent, '未绑定')
    await act(async () => {
      dblClickEl(rowByName('pressed')!)
      await new Promise((r) => setTimeout(r, 30))
    })
    const notice = dom.document.querySelector('.ev-notice')
    assert.ok(notice, '出现提示')
    assert.match(notice!.textContent ?? '', new RegExp(NO_LOGIC_MESSAGE))
    assert.equal(notice!.querySelector('.ev-btn')?.textContent, '新建蓝图并挂载')
    // 「新建蓝图并挂载」→ prompt + PUT + 双写（打桩 prompt 返回路径）
    installPrompt('logic/bound.bp.json')
    await act(async () => {
      clickEl(notice!.querySelector('.ev-btn') as unknown as Element)
      await new Promise((r) => setTimeout(r, 30))
    })
    const bound = (getDomainState<SceneTreeDomainState>('scene-tree').asset as UIAsset).root
    assert.equal(bound.logicAsset, 'logic/bound.bp.json', '快捷挂载已写入绑定')
  } finally {
    await unmount()
  }
})

test('组件：未选节点 → 提示 + 活动蓝图 tab 的资产级自定义事件', async () => {
  setupComponent({ selection: [] })
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    assert.match(dom.document.querySelector('.ev-empty')?.textContent ?? '', /选中 UI 节点查看事件/)
    // 资产级列表（活动蓝图 tab = logic/main.bp.json）
    const customHead = Array.from(dom.document.querySelectorAll('.ev-section-head')).find((h) =>
      (h.textContent ?? '').includes('自定义事件'),
    )
    assert.ok(customHead, '资产级自定义事件节存在')
    assert.match(customHead!.textContent ?? '', /logic\/main\.bp\.json/)
    assert.ok(rowByName('loaded'), '资产级事件行渲染')
    // 资产级行双击同样可跳转（蓝图已开 → goto parseLog:c_title + 选中）
    await act(async () => {
      dblClickEl(rowByName('saved')!)
      await new Promise((r) => setTimeout(r, 30))
    })
    const st = useBlueprintStore.getState()
    assert.equal(st.graphName, 'parseLog', '资产级双击切到入口所在图')
    assert.deepEqual(st.selection.nodeIds, ['c_title'], '资产级双击选中入口节点')
  } finally {
    await unmount()
  }
})

test('组件：右键行 → 上下文菜单（跳转 / 复制事件名）', async () => {
  setupComponent()
  const { unmount } = await mountEl(createElement(EventsPanel, {}))
  try {
    await flush()
    const row = rowByName('loaded')!
    await act(async () => {
      row.dispatchEvent(new dom.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }) as unknown as Event)
      await new Promise((r) => setTimeout(r, 10))
    })
    const menu = dom.document.querySelector('.fs-menu')
    assert.ok(menu, '菜单弹出（portal）')
    const labels = Array.from(menu!.querySelectorAll('.fs-menu-label')).map((l) => l.textContent)
    assert.deepEqual(labels, ['跳转事件入口', '复制事件名'])
  } finally {
    await unmount()
  }
})

test('EventRowItem：entry 未知的行渲染占位点标（.ts 场景），已知无入口为空心点标', async () => {
  const row: EventRowModel = { name: 'loaded', label: 'loaded', source: 'custom' }
  const { unmount } = await mountEl(
    createElement(EventRowItem, { row, onActivate: () => {}, onContext: () => {} }),
  )
  try {
    const dot = dom.document.querySelector('.ev-dot')
    assert.ok(dot, '占位点标渲染（保持行对齐）')
    assert.ok(dot!.classList.contains('ev-dot--none'), 'entry 未知 = 占位（visibility hidden）')
    assert.ok(!dot!.classList.contains('ev-dot--on'), '未知不亮')
  } finally {
    await unmount()
  }
  const withFlag: EventRowModel = { ...row, entry: false }
  const { unmount: unmount2 } = await mountEl(
    createElement(EventRowItem, { row: withFlag, onActivate: () => {}, onContext: () => {} }),
  )
  try {
    const dot2 = dom.document.querySelector('.ev-dot')
    assert.ok(dot2 !== null, 'entry 已知（false）渲染空心点标')
    assert.ok(!dot2!.classList.contains('ev-dot--on'))
  } finally {
    await unmount2()
  }
})
