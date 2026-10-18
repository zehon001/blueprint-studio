/**
 * 检视器面板单元测试（T1.5 DoD · node:test + happy-dom）
 *
 * 覆盖（任务卡「单测」清单逐条）：
 *  1. storeLocation 映射表（name / position / size / rotation / 其余 → props）+ 读写往返
 *  2. 共同属性计算（多选 2-3 节点 schema 交集；同名不同型/不同组剔除）+ 混合态判定（同值/异值/默认值回落）
 *  3. 批量应用单命令（「检视器：批量修改 <属性> N 个」）+ undo 一次还原全部（各自原值）+ vec2 增量合并
 *  4. 搜索过滤纯函数（label / id 包含匹配、大小写不敏感、空关键字全量）
 *  5. 13 种 PropType 控件渲染冒烟（happy-dom 挂载：单值 + 混合态两种）+ 未知类型回落
 *  6. 修改入命令栈：改 text → 资产变化 + undo 还原；数字草稿态 Enter 提交才入栈；布尔即改即提交
 *  另含：分组组序 / 组头折叠记忆 / 搜索命中自动展开 / 无匹配提示 / 空态资产信息 /
 *       内建事件区与跳转占位 toast / disabled 父级语义 / listColumns JSON 校验。
 *
 * 运行：npx tsx --test src/panels/inspector/inspector.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIAsset, UINode, Vec2, Size2 } from '@/ir/types'
import { defaultPropsFor, getUISchema, commonProps, type ListColumn, type PropDef } from '@/ui-editor/schema'
import { peekUndo, redo, registerDomainState, resetEditorStore, runCommand, undo } from '@/shell/commands'
import { useUIEditorStore, getSceneTreeDomain, type SceneTreeDomainState } from '@/ui-editor/store'
import {
  MIXED_TITLE,
  PROPTYPE_COVERAGE,
  anyRowDisabled,
  effectiveDisabled,
  filterPropDefs,
  findUIParent,
  groupPropRows,
  intersectPropDefs,
  parseListColumnsJson,
  parseOptionsLines,
  propCommandLabel,
  propRowStates,
  readProp,
  readRawProp,
  storeLocation,
  writeProp,
  writePropsOnNodes,
} from './inspector-model'

/* ============================================================
 * 样本构造
 * ============================================================ */

/** 按 schema 默认值构造 UINode（transform/props 拆分与 T1.4 新建节点约定一致） */
function uiNode(
  id: string,
  type: string,
  name: string,
  props: Record<string, unknown> = {},
  children: UINode[] = [],
): UINode {
  const defaults = defaultPropsFor(type)
  const merged = { ...defaults, ...props } as Record<string, unknown>
  delete merged.name
  delete merged.position
  delete merged.size
  delete merged.rotation
  return {
    id,
    type,
    name,
    transform: {
      position: (props.position ?? defaults.position) as Vec2,
      size: (props.size ?? defaults.size) as Size2,
      rotation: (props.rotation ?? defaults.rotation) as number,
    },
    theme: {},
    props: merged,
    children,
  }
}

/**
 * 重置编辑器 store 并重挂 scene-tree 命令域（asset = null）。
 * 两个坑（均出在测试编排，不改 store 源码）：
 *  1. resetEditorStore 清掉域本身，但 store.ts 的 ensureDomain 模块级标记仍是「已注册」，
 *     后续 runCommand 会报域未注册 → 显式 registerDomainState 重挂；
 *  2. 若先 registerDomainState 后挂载面板，面板内 useSceneTreeDomain → ensureDomain
 *     在标记未置位时会用 {asset:null} 整体替换域状态 → 必须先 getSceneTreeDomain() 置位标记。
 */
function resetOnly(): void {
  resetEditorStore()
  getSceneTreeDomain()
  registerDomainState<SceneTreeDomainState>('scene-tree', { asset: null })
}

/** 打开 UI 资产（重置命令栈 → 注册 scene-tree 域 → 资产入域；清空选中） */
function openAsset(root: UINode, name = '测试 UI'): void {
  resetOnly()
  runCommand<SceneTreeDomainState>('scene-tree', '打开 UI', (d) => {
    d.asset = { version: 2, name, root }
  })
  useUIEditorStore.setState({ selection: [], projectPath: 'P', assetPath: 'ui/main.ui.json', status: 'ready' })
}

function domainAsset(): UIAsset {
  return getSceneTreeDomain().asset as UIAsset
}

function textDef(): PropDef {
  return getUISchema('label')!.props.find((p) => p.id === 'text')!
}

function positionDef(kind: 'free' | 'flow' = 'flow'): PropDef {
  return commonProps(kind).find((p) => p.id === 'position')!
}

/* ============================================================
 * 1. storeLocation 映射表（DoD 单测 1）
 * ============================================================ */

test('storeLocation：name/position/size/rotation/其余 的存储位置映射', () => {
  const defs = commonProps('free')
  assert.deepEqual(storeLocation(defs.find((p) => p.id === 'name')!), { kind: 'name' })
  assert.deepEqual(storeLocation(defs.find((p) => p.id === 'position')!), {
    kind: 'transform',
    field: 'position',
  })
  assert.deepEqual(storeLocation(defs.find((p) => p.id === 'size')!), { kind: 'transform', field: 'size' })
  assert.deepEqual(storeLocation(defs.find((p) => p.id === 'rotation')!), {
    kind: 'transform',
    field: 'rotation',
  })
  // 其余（含公共组与非公共属性）一律 → props
  for (const id of ['visible', 'tooltip', 'expand']) {
    assert.deepEqual(storeLocation(defs.find((p) => p.id === id)!), { kind: 'props' })
  }
  assert.deepEqual(storeLocation(textDef()), { kind: 'props' })
  assert.deepEqual(storeLocation(getUISchema('list')!.props.find((p) => p.id === 'columns')!), { kind: 'props' })
})

test('readProp / writeProp：按存储位置读写与默认值回落', () => {
  const defs = commonProps('free')
  const nameDef = defs.find((p) => p.id === 'name')!
  const posDef = defs.find((p) => p.id === 'position')!
  const sizeDef = defs.find((p) => p.id === 'size')!
  const rotDef = defs.find((p) => p.id === 'rotation')!
  const tDef = textDef()
  const node = uiNode('n1', 'label', '标签', { text: '原始' })

  writeProp(node, nameDef, '新名')
  writeProp(node, posDef, { x: 5, y: 6 })
  writeProp(node, sizeDef, { w: 100, h: 40 })
  writeProp(node, rotDef, 30)
  writeProp(node, tDef, '新文本')

  assert.equal(node.name, '新名', 'name → UINode.name')
  assert.deepEqual(node.transform.position, { x: 5, y: 6 }, 'position → transform.position')
  assert.deepEqual(node.transform.size, { w: 100, h: 40 }, 'size → transform.size')
  assert.equal(node.transform.rotation, 30, 'rotation → transform.rotation')
  assert.equal(node.props['text'], '新文本', '其余 → props')

  assert.equal(readProp(node, nameDef), '新名')
  assert.deepEqual(readProp(node, posDef), { x: 5, y: 6 })
  assert.equal(readProp(node, tDef), '新文本')

  // 未写入 → 回落 PropDef.default（与 T2.4 commonParamRows 口径一致）
  const bare: UINode = {
    id: 'n2',
    type: 'label',
    name: '空',
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [],
  }
  assert.equal(readRawProp(bare, tDef), undefined, '未写入时 readRawProp 为 undefined')
  assert.equal(readProp(bare, tDef), '文本', 'readProp 回落 PropDef.default')

  // 缺失 transform 的旧资产：writeProp 兜底初始化
  const broken = {
    id: 'n3',
    type: 'label',
    name: 'x',
    transform: undefined,
    theme: {},
    props: {},
    children: [],
  } as unknown as UINode
  writeProp(broken, sizeDef, { w: 8, h: 9 })
  assert.deepEqual(broken.transform.size, { w: 8, h: 9 })
})

test('writePropsOnNodes：批量写入与 vec2/size 增量合并', () => {
  const root = uiNode('root', 'panel', '面板', {}, [
    uiNode('a', 'label', 'A', { position: { x: 1, y: 10 } }),
    uiNode('b', 'label', 'B', { position: { x: 2, y: 20 } }),
    uiNode('c', 'label', 'C', { position: { x: 3, y: 30 } }),
  ])
  const posDef = positionDef('flow')

  // 全量值：三个节点写成同一值
  assert.equal(writePropsOnNodes(root, ['a', 'b', 'c'], posDef, { x: 0, y: 0 }, false), 3)
  assert.deepEqual(root.children.map((c) => c.transform.position), [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ])

  // 增量补丁：只改 X，各节点保留自己的 Y
  assert.equal(writePropsOnNodes(root, ['a', 'b', 'c'], posDef, { x: 9 }, true), 3)
  assert.deepEqual(root.children.map((c) => c.transform.position), [
    { x: 9, y: 0 },
    { x: 9, y: 0 },
    { x: 9, y: 0 },
  ])

  // 不存在的 id 跳过；未知字段合并到空对象
  assert.equal(writePropsOnNodes(root, ['zzz'], posDef, { y: 7 }, true), 0)
})

/* ============================================================
 * 2. 共同属性计算 + 混合态判定（DoD 单测 2）
 * ============================================================ */

test('intersectPropDefs：多选共同属性交集（同名不同型 / 不同组剔除）', () => {
  const labelP = getUISchema('label')!.props
  const buttonP = getUISchema('button')!.props

  // label + button：共同 = 公共组 7 项 + text（两侧均为 string/内容 同名同型同组）
  const common = intersectPropDefs([labelP, buttonP])
  assert.deepEqual(
    common.map((d) => d.id),
    ['name', 'position', 'size', 'rotation', 'visible', 'tooltip', 'expand', 'text'],
  )

  // slider + spinBox：min/max/step/value 同为 number → 全部共同
  const numeric = intersectPropDefs([getUISchema('slider')!.props, getUISchema('spinBox')!.props])
  for (const id of ['min', 'max', 'step', 'value']) {
    assert.ok(numeric.some((d) => d.id === id), `slider/spinbox 共同含 ${id}`)
  }

  // optionButton.value(string) vs spinBox.value(number) → 同名不同型剔除
  const valueClash = intersectPropDefs([getUISchema('optionButton')!.props, getUISchema('spinBox')!.props])
  assert.equal(valueClash.some((d) => d.id === 'value'), false, 'value 类型不同不作为共同属性')

  // scrollBox.direction(行为) vs separator.direction(布局) → 同名不同组剔除
  const dirClash = intersectPropDefs([getUISchema('scrollBox')!.props, getUISchema('separator')!.props])
  assert.equal(dirClash.some((d) => d.id === 'direction'), false, 'direction 分组不同不作为共同属性')

  // 三节点交集 = 两两交集（label/button/checkBox 的 text 声明一致）
  const triple = intersectPropDefs([labelP, buttonP, getUISchema('checkBox')!.props])
  assert.deepEqual(triple.map((d) => d.id), [
    'name',
    'position',
    'size',
    'rotation',
    'visible',
    'tooltip',
    'expand',
    'text',
  ])

  assert.deepEqual(intersectPropDefs([]), [], '空列表')
  assert.deepEqual(intersectPropDefs([labelP]), labelP, '单列表原样')
})

test('propRowStates：混合态判定（同值 / 异值 / 默认值回落）', () => {
  const tDef = textDef()
  const posDef = positionDef('flow')
  const a = uiNode('a', 'label', 'A', { text: '同' })
  const b = uiNode('b', 'label', 'B', { text: '同' })

  assert.deepEqual(propRowStates([], [tDef]), [], '无节点返回空')

  const same = propRowStates([a, b], [tDef])[0]!
  assert.equal(same.mixed, false, '值全同 → 显示值')
  assert.equal(same.value, '同')

  const diverged = propRowStates([a, uiNode('c', 'label', 'C', { text: '异' })], [tDef])[0]!
  assert.equal(diverged.mixed, true, '值不同 → 混合态')
  assert.equal(diverged.value, '同', '混合态 value 取首个节点值')
  assert.equal(MIXED_TITLE.length > 0, true)

  // 未写入 → 各自回落默认值（相同 → 非混合）
  const fallback = propRowStates([uiNode('d', 'button', 'D'), uiNode('e', 'button', 'E')], [
    getUISchema('button')!.props.find((p) => p.id === 'variant')!,
  ])[0]!
  assert.equal(fallback.mixed, false, '默认值回落相同 → 非混合')
  assert.equal(fallback.value, 'primary')

  // 向量值：JSON 深比较
  const posRows = propRowStates(
    [
      uiNode('f', 'label', 'F', { position: { x: 1, y: 2 } }),
      uiNode('g', 'label', 'G', { position: { x: 1, y: 2 } }),
    ],
    [posDef],
  )[0]!
  assert.equal(posRows.mixed, false, '向量值相同 → 非混合')
  const posMixed = propRowStates(
    [
      uiNode('h', 'label', 'H', { position: { x: 1, y: 2 } }),
      uiNode('i', 'label', 'I', { position: { x: 1, y: 3 } }),
    ],
    [posDef],
  )[0]!
  assert.equal(posMixed.mixed, true, '向量值不同 → 混合')

  // 多选 3 节点：2 同 1 异 → 混合
  const triple = propRowStates(
    [uiNode('j', 'label', 'J', { text: 'x' }), uiNode('k', 'label', 'K', { text: 'x' }), uiNode('l', 'label', 'L', { text: 'y' })],
    [tDef],
  )[0]!
  assert.equal(triple.mixed, true, '3 节点任一不同 → 混合')
})

test('groupPropRows：组序 PROP_GROUP_ORDER 在前、未知分组按出现序排后', () => {
  const rows = propRowStates(
    [uiNode('n', 'label', 'N')],
    [
      { id: 'text', label: '文本', type: 'string', group: '内容' },
      { id: 'name', label: '名称', type: 'string', group: '节点' },
      { id: 'custom', label: '自定义', type: 'string', group: '扩展组' },
      { id: 'size', label: '尺寸', type: 'size', group: '布局' },
    ],
  )
  assert.deepEqual(
    groupPropRows(rows).map((g) => g.group),
    ['节点', '布局', '内容', '扩展组'],
  )
  assert.deepEqual(groupPropRows([]), [])
})

/* ============================================================
 * 3. 搜索过滤纯函数（DoD 单测 4）
 * ============================================================ */

test('filterPropDefs：label / id 包含匹配，大小写不敏感，空关键字全量', () => {
  const props = getUISchema('label')!.props
  assert.deepEqual(filterPropDefs(props, '').length, props.length, '空关键字 → 全量')
  assert.deepEqual(filterPropDefs(props, '   ').length, props.length, '空白关键字 → 全量')

  const byLabel = filterPropDefs(props, '文本')
  assert.deepEqual(byLabel.map((d) => d.id), ['text'], '中文显示名可命中')

  const byId = filterPropDefs(props, 'text')
  assert.deepEqual(byId.map((d) => d.id), ['text'], '属性 id 可命中')
  assert.deepEqual(filterPropDefs(props, 'TEXT').map((d) => d.id), ['text'], '大小写不敏感')

  const byName = filterPropDefs(props, '名称')
  assert.ok(byName.some((d) => d.id === 'name'), '公共属性名称可命中')

  assert.deepEqual(filterPropDefs(props, '不存在的属性xyz'), [], '无命中 → 空列表')
})

/* ============================================================
 * 4. disabled 父级语义 + 命令 label + 结构化解析
 * ============================================================ */

test('effectiveDisabled / findUIParent / anyRowDisabled：position 按父级解锁', () => {
  const posFlow = positionDef('flow')
  const child = uiNode('c', 'label', '子')
  const panel = uiNode('p', 'panel', '面板', {}, [uiNode('p1', 'label', '自由子节点')])
  const vbox = uiNode('v', 'vbox', '容器', {}, [child])

  // position：存储位置由父级接管决定（与 schema 的 disabled 标记无关——标记只是默认提示）
  assert.equal(effectiveDisabled(posFlow, null), false, '根节点 → position 解锁')
  assert.equal(effectiveDisabled(posFlow, panel), false, '自由容器（panel）内 → 解锁')
  assert.equal(effectiveDisabled(posFlow, vbox), true, '流式容器（vbox）内 → 置灰')

  // 非 position：按 schema 声明
  const posFree = positionDef('free')
  assert.equal(effectiveDisabled(posFree, panel), false, '自由容器内（free 声明）→ 可编辑')
  assert.equal(effectiveDisabled(posFree, vbox), true, '流式容器内（free 声明）→ 仍被父级接管置灰')
  const marked = { id: 'x', label: 'X', type: 'string', group: '内容', disabled: true } as PropDef
  assert.equal(effectiveDisabled(marked, null), true, 'schema 声明 disabled → 置灰')
  const unmarked = { id: 'y', label: 'Y', type: 'string', group: '内容' } as PropDef
  assert.equal(effectiveDisabled(unmarked, vbox), false, 'schema 未声明 disabled → 可编辑')

  assert.equal(findUIParent(vbox, 'c'), vbox, '查父节点')
  assert.equal(findUIParent(vbox, 'v'), null, '根无父节点')
  assert.equal(findUIParent(vbox, 'zzz'), null, '未知 id → null')

  // 多选：任一被接管 → 整行置灰
  const mixedTree = uiNode('r', 'panel', 'R', {}, [uiNode('p1', 'label', 'P1'), uiNode('p2', 'label', 'P2')])
  const vbox2 = uiNode('vv', 'vbox', 'V', {}, [uiNode('q1', 'label', 'Q1')])
  const forest = uiNode('forest', 'panel', 'F', {}, [mixedTree, vbox2])
  assert.equal(
    anyRowDisabled(posFlow, [mixedTree.children[0]!, vbox2.children[0]!], forest),
    true,
    '任一节点 position 被接管 → 置灰',
  )
})

test('propCommandLabel：检视器前缀与批量计数', () => {
  const tDef = textDef()
  assert.equal(propCommandLabel(tDef, 1), '检视器：文本')
  assert.equal(propCommandLabel(tDef, 3), '检视器：批量修改 文本 3 个')
})

test('parseListColumnsJson / parseOptionsLines：列定义 JSON 校验', () => {
  const ok = parseListColumnsJson(
    JSON.stringify([
      { field: 'level', title: '级别', width: 80, colorRules: [{ op: 'eq', value: 'INFO', color: '#3fc1a9' }] },
      { field: 'message', title: '内容', mergeDuplicates: true },
    ]),
  )
  assert.equal(ok.ok, true)
  assert.equal((ok as { value: ListColumn[] }).value.length, 2)

  assert.equal(parseListColumnsJson('not json').ok, false, '非法 JSON')
  assert.match((parseListColumnsJson('not json') as { message: string }).message, /JSON 解析失败/)
  assert.match((parseListColumnsJson('{"a":1}') as { message: string }).message, /数组/)
  assert.match((parseListColumnsJson('[]') as { message: string }).message, /至少需要一列/)
  assert.match((parseListColumnsJson('[{"title":"缺字段"}]') as { message: string }).message, /field/)
  assert.match((parseListColumnsJson('[{"field":"f"}]') as { message: string }).message, /title/)
  assert.match(
    (parseListColumnsJson('[{"field":"f","title":"F","width":"auto"}]') as { message: string }).message,
    /width/,
  )
  assert.match(
    (parseListColumnsJson('[{"field":"f","title":"F","colorRules":[{"op":"nope","value":"v","color":"#fff"}]}]') as {
      message: string
    }).message,
    /op/,
  )
  assert.match(
    (parseListColumnsJson('[{"field":"f","title":"F","colorRules":[{"op":"eq","value":"v","color":"red"}]}]') as {
      message: string
    }).message,
    /color/,
  )

  assert.deepEqual(parseOptionsLines(' 甲 \n\n乙\n'), ['甲', '乙'], '按行拆分去空白')
  assert.deepEqual(parseOptionsLines(''), [])
})

/* ============================================================
 * 5. DOM 冒烟（happy-dom）
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
const { PropEditor } = await import('./PropEditors')
const { InspectorPanel } = await import('./InspectorPanel')

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

/** React 受控输入框设值（native setter + input 事件） */
function setControlledValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof dom.HTMLTextAreaElement ? dom.HTMLTextAreaElement : dom.HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

function pressEnter(el: HTMLInputElement): void {
  el.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event)
}

/** 派发可冒泡的 focusout（React onBlur 的委托事件；非冒泡 blur 不会触发面板失焦提交） */
function blurEl(el: HTMLElement): void {
  el.dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
}

/** 派发点击（React onClick 委托） */
function clickEl(el: Element): void {
  el.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
}

/** act 包裹的撤销 / 重做（面板仍挂载时，域更新必须 flush 否则草稿态被下一次 act 冲掉） */
function doUndo(): void {
  act(() => {
    undo()
  })
}

function doRedo(): string {
  let label = ''
  act(() => {
    label = redo()?.label ?? ''
  })
  return label
}

/** 按属性行标签查找行元素 */
function findRow(label: string): HTMLElement | null {
  for (const row of Array.from(dom.document.querySelectorAll('.insp-row'))) {
    const lab = row.querySelector('.insp-label')
    if (lab?.textContent === label) return row as unknown as HTMLElement
  }
  return null
}

/* —— 5a. 13 种 PropType 控件渲染冒烟（单值 + 混合态） —— */

function editorDef(type: string): PropDef {
  const base = { id: 'p1', label: '属性', group: '内容' } as const
  switch (type) {
    case 'select':
      return { ...base, type, default: 'a', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] }
    case 'number':
      return { ...base, type, default: 1.5, min: 0, max: 10, step: 0.5 }
    case 'int':
      return { ...base, type, default: 3 }
    case 'bool':
      return { ...base, type, default: true }
    case 'color':
      return { ...base, type, default: '#ff0000' }
    case 'vec2':
      return { ...base, type, default: { x: 1, y: 2 } }
    case 'size':
      return { ...base, type, default: { w: 10, h: 20 } }
    case 'options':
      return { ...base, type, default: ['甲', '乙'] }
    case 'listColumns':
      return { ...base, type, default: [{ field: 'f', title: 'F' }] }
    default:
      return { ...base, type, default: '值' } as PropDef
  }
}

function editorValue(type: string): unknown {
  return editorDef(type).default
}

/** 各类型的期望控件形态：tag → 数量 */
const EXPECTED_DOM: Record<string, Array<readonly [string, number]>> = {
  number: [['input[type=number]', 1]],
  int: [['input[type=number]', 1]],
  string: [['input[type=text]', 1]],
  bool: [['input[type=checkbox]', 1]],
  select: [['select', 1]],
  color: [
    ['input[type=color]', 1],
    ['input[type=text]', 1],
  ],
  textarea: [['textarea', 1]],
  vec2: [['input[type=number]', 2]],
  size: [['input[type=number]', 2]],
  options: [['textarea', 1]],
  listColumns: [['textarea', 1]],
  assetRef: [['input[type=text]', 1]],
  logicRef: [['input[type=text]', 1]],
}

test('PropEditor 覆盖冒烟：13 种 PropType 单值渲染 + 多选混合态渲染 + 未知类型回落', async () => {
  assert.equal(PROPTYPE_COVERAGE.length, 13, 'UIPropType 声明成员全覆盖（schema 联合共 13 种）')
  for (const type of PROPTYPE_COVERAGE) {
    for (const mixed of [false, true]) {
      const { container, unmount } = await mountEl(
        createElement(PropEditor, {
          def: editorDef(type),
          value: editorValue(type),
          mixed,
          disabled: false,
          onCommit: () => {},
        }),
      )
      try {
        // 颜色混合态无法以「—」占位输入框呈现 → 渲染混合标记
        const expected: ReadonlyArray<readonly [string, number]> =
          mixed && type === 'color' ? [['.insp-mixed-mark', 1]] : (EXPECTED_DOM[type] ?? [])
        for (const [selector, count] of expected) {
          assert.equal(
            container.querySelectorAll(selector).length,
            count,
            `${type}（${mixed ? '混合' : '单值'}）应含 ${selector} × ${count}`,
          )
        }
        if (mixed) {
          const withPlaceholder = container.querySelector<HTMLElement>('input[placeholder], textarea[placeholder]')
          if (withPlaceholder) {
            assert.equal(withPlaceholder.getAttribute('placeholder'), '—', `${type} 混合态占位为「—」`)
          }
        }
      } finally {
        await unmount()
      }
    }
  }

  // 未知类型回落单行文本（兜底可编辑）
  const { container, unmount } = await mountEl(
    createElement(PropEditor, {
      def: { id: 'p', label: 'P', type: 'mysteryType' as never, group: '内容', default: '' },
      value: '',
      mixed: false,
      disabled: false,
      onCommit: () => {},
    }),
  )
  try {
    assert.equal(container.querySelectorAll('input[type=text]').length, 1, '未知类型回落文本框')
  } finally {
    await unmount()
  }
})

/* —— 5b. 面板渲染：单选分组 / 折叠 / 搜索 / 事件区 / 空态 —— */

test('面板单选：分组组序、doc 悬浮提示、类型徽标、内建事件区与跳转占位', async () => {
  dom.document.body.innerHTML = ''
  openAsset(uiNode('btn', 'button', '提交按钮', { text: '提交' }))
  useUIEditorStore.getState().setSelection(['btn'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    // 头部：名称 / 类型徽标 / id
    assert.equal(dom.document.querySelector('.insp-title')?.textContent, '提交按钮')
    assert.equal(dom.document.querySelector('.insp-badge')?.textContent, '按钮')

    // 分组组序（v3 T9.5：flex 布局条目在前；button 的组：节点/布局/内容/外观）
    const groupTitles = Array.from(dom.document.querySelectorAll('.insp-group-title')).map((el) => el.textContent)
    assert.deepEqual(groupTitles, ['布局（flex）', '节点', '布局', '内容', '外观'])

    // doc 悬浮提示（title 属性）+ 类型徽标
    const textRow = findRow('文本')!
    assert.ok(textRow, '文本属性行存在')
    assert.equal(
      textRow.querySelector('.insp-label')?.getAttribute('title'),
      getUISchema('button')!.props.find((p) => p.id === 'text')!.doc,
      '属性行 title = PropDef.doc',
    )
    assert.equal(textRow.querySelector('.insp-type')?.textContent, '文本')

    // 组头折叠（本地 state 记忆）与再展开
    const bodiesBefore = dom.document.querySelectorAll('.insp-group-body').length
    act(() => {
      clickEl(dom.document.querySelector('.insp-group-head') as unknown as Element)
    })
    assert.equal(dom.document.querySelectorAll('.insp-group-body').length, bodiesBefore - 1, '点击组头折叠')
    act(() => {
      clickEl(dom.document.querySelector('.insp-group-head') as unknown as Element)
    })
    assert.equal(dom.document.querySelectorAll('.insp-group-body').length, bodiesBefore, '再点展开')

    // 内建事件区：pressed 行 + 跳转占位 toast
    assert.equal(dom.document.querySelector('.insp-events-title')?.textContent, '内建事件')
    const eventRow = dom.document.querySelector('.insp-event-row') as unknown as HTMLElement
    assert.equal(eventRow.querySelector('.insp-event-name')?.textContent, '按下')
    act(() => {
      clickEl(eventRow.querySelector('button')!)
    })
    assert.equal(dom.document.querySelector('.insp-toast')?.textContent, 'T5.2 事件面板接入')
  } finally {
    await unmount()
  }
})

test('面板搜索：命中过滤 + 命中组自动展开 + 无匹配提示', async () => {
  dom.document.body.innerHTML = ''
  openAsset(uiNode('btn', 'button', '提交按钮'))
  useUIEditorStore.getState().setSelection(['btn'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    // 先折叠第一组（节点）
    act(() => {
      clickEl(dom.document.querySelector('.insp-group-head') as unknown as Element)
    })
    const collapsedBodies = dom.document.querySelectorAll('.insp-group-body').length

    const search = dom.document.querySelector('.insp-search') as unknown as HTMLInputElement
    act(() => setControlledValue(search, '文本'))
    // 命中组自动展开（折叠记忆被忽略）：文本在「内容」组 → 至少内容组展开
    const searchingBodies = dom.document.querySelectorAll('.insp-group-body').length
    assert.ok(searchingBodies > 0, '搜索态分组自动展开')
    const visibleLabels = Array.from(dom.document.querySelectorAll('.insp-label')).map((el) => el.textContent)
    assert.deepEqual(visibleLabels, ['文本'], '搜索「文本」只命中文本属性行')

    // 无匹配 → 「无匹配属性」
    act(() => setControlledValue(search, '不存在属性xyz'))
    assert.equal(dom.document.querySelector('.insp-empty-inline')?.textContent, '无匹配属性')

    // 清空搜索 → 恢复全量，且先前折叠记忆保留
    act(() => setControlledValue(search, ''))
    assert.equal(dom.document.querySelectorAll('.insp-group-body').length, collapsedBodies, '折叠状态记忆保持')
  } finally {
    await unmount()
  }
})

test('面板空态：未打开资产提示 / 资产信息（名 / 节点数）', async () => {
  dom.document.body.innerHTML = ''

  // 未打开资产
  resetOnly()
  const first = await mountEl(createElement(InspectorPanel, {}))
  try {
    assert.match(dom.document.querySelector('.insp-empty')?.textContent ?? '', /未打开 UI 资产/)
  } finally {
    await first.unmount()
  }

  // 已打开未选中：显示资产名 + 节点数
  dom.document.body.innerHTML = ''
  openAsset(
    uiNode('root', 'panel', '根', {}, [
      uiNode('a', 'label', 'A'),
      uiNode('b', 'button', 'B'),
    ]),
  )
  const second = await mountEl(createElement(InspectorPanel, {}))
  try {
    const text = dom.document.querySelector('.insp-empty')?.textContent ?? ''
    assert.match(text, /未选中节点/)
    assert.match(text, /资产：测试 UI/)
    assert.match(text, /节点数：3/)
  } finally {
    await second.unmount()
  }
})

/* —— 6. 修改入命令栈（DoD 单测 6） —— */

test('面板修改入栈：text 草稿态 Enter 提交 → 资产变化 + undo 还原；输入过程不入栈', async () => {
  dom.document.body.innerHTML = ''
  openAsset(uiNode('lab', 'label', '标签', { text: '原始' }))
  useUIEditorStore.getState().setSelection(['lab'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    const input = findRow('文本')!.querySelector<HTMLInputElement>('input[type=text]')!

    // 草稿态：逐键输入不产生命令
    act(() => setControlledValue(input, '新文本'))
    assert.equal(peekUndo()?.label, '打开 UI', '输入过程未入栈（栈顶仍是打开资产命令）')
    assert.equal(domainAsset().root.props['text'], '原始', '草稿态未写入资产')

    // Enter 提交 → 单命令入栈
    act(() => pressEnter(input))
    assert.equal(domainAsset().root.props['text'], '新文本', 'Enter 提交写入资产')
    assert.equal(peekUndo()?.label, '检视器：文本', 'label 前缀「检视器：」')

    // undo 还原
    doUndo()
    assert.equal(domainAsset().root.props['text'], '原始', 'undo 还原')
    assert.equal(doRedo(), '检视器：文本', 'redo 可重做')
    assert.equal(domainAsset().root.props['text'], '新文本')
    doUndo()
  } finally {
    await unmount()
  }
})

test('面板修改入栈：数字草稿态 Enter 才入栈（含小数与钳制），布尔即改即提交', async () => {
  dom.document.body.innerHTML = ''
  openAsset(uiNode('lab', 'label', '标签'))
  useUIEditorStore.getState().setSelection(['lab'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    // 数字（rotation）：输入过程不入栈，Enter 提交
    const rot = findRow('旋转')!.querySelector<HTMLInputElement>('input[type=number]')!
    act(() => setControlledValue(rot, '45'))
    assert.equal(peekUndo()?.label, '打开 UI', '数字草稿态未入栈')
    assert.equal(domainAsset().root.transform.rotation, 0)
    act(() => pressEnter(rot))
    assert.equal(domainAsset().root.transform.rotation, 45, 'Enter 提交 rotation')
    assert.equal(peekUndo()?.label, '检视器：旋转')
    doUndo()
    assert.equal(domainAsset().root.transform.rotation, 0, 'undo 还原 rotation')

    // number 保留小数 + max 钳制（rotation: -360~360）
    act(() => setControlledValue(rot, '7.6'))
    act(() => pressEnter(rot))
    assert.equal(domainAsset().root.transform.rotation, 7.6, 'number 类型提交保留小数')
    doUndo()
    act(() => setControlledValue(rot, '500'))
    act(() => pressEnter(rot))
    assert.equal(domainAsset().root.transform.rotation, 360, '超出 max 钳制')
    doUndo()

    // 布尔（可见）：即改即提交
    const visible = findRow('可见')!.querySelector<HTMLInputElement>('input[type=checkbox]')!
    act(() => {
      visible.click()
    })
    assert.equal(domainAsset().root.props['visible'], false, '布尔即改即提交')
    assert.equal(peekUndo()?.label, '检视器：可见')
    doUndo()
    assert.equal(domainAsset().root.props['visible'], true, 'undo 还原布尔')
  } finally {
    await unmount()
  }
})

test('NumberEditor：int 取整、min/max 钳制、非法输入不提交', async () => {
  const commits: unknown[] = []
  const def: PropDef = { id: 'n', label: '数量', type: 'int', group: '内容', default: 0, min: 0, max: 10 }
  const { container, unmount } = await mountEl(
    createElement(PropEditor, { def, value: 0, mixed: false, disabled: false, onCommit: (v) => commits.push(v) }),
  )
  try {
    const input = container.querySelector('input[type=number]') as HTMLInputElement
    act(() => setControlledValue(input, '2.6'))
    act(() => pressEnter(input))
    assert.deepEqual(commits, [3], 'int 提交取整')

    act(() => setControlledValue(input, '99'))
    act(() => pressEnter(input))
    assert.deepEqual(commits, [3, 10], '超出 max 钳制到 10')

    const before = commits.length
    act(() => setControlledValue(input, 'abc'))
    act(() => pressEnter(input))
    assert.equal(commits.length, before, '非法输入不提交')
    assert.equal(input.value, '0', '非法输入回退草稿')
  } finally {
    await unmount()
  }
})

test('面板多选：混合态「—」、批量修改单命令、undo 一次还原全部各自原值、vec2 增量合并', async () => {
  dom.document.body.innerHTML = ''
  const root = uiNode('panel1', 'panel', '面板', {}, [
    uiNode('a', 'label', 'A', { text: '甲', position: { x: 1, y: 10 } }),
    uiNode('b', 'label', 'B', { text: '乙', position: { x: 2, y: 20 } }),
    uiNode('c', 'label', 'C', { text: '丙', position: { x: 3, y: 30 } }),
  ])
  openAsset(root)
  useUIEditorStore.getState().setSelection(['a', 'b', 'c'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    // 头部：多选数量
    assert.equal(dom.document.querySelector('.insp-title')?.textContent, '已选中 3 个节点')
    assert.match(dom.document.querySelector('.insp-hint')?.textContent ?? '', /共同属性/)

    // 文本混合态：占位「—」
    const textInput = findRow('文本')!.querySelector<HTMLInputElement>('input[type=text]')!
    assert.equal(textInput.getAttribute('placeholder'), '—', '混合态显示「—」')

    // 批量修改：单命令应用到全部节点
    act(() => setControlledValue(textInput, '统一'))
    act(() => pressEnter(textInput))
    const texts = domainAsset().root.children.map((c) => c.props['text'])
    assert.deepEqual(texts, ['统一', '统一', '统一'], '批量应用到全部节点')
    assert.equal(peekUndo()?.label, '检视器：批量修改 文本 3 个', '单命令 label')

    // undo 一次 → 全部还原为各自原值
    doUndo()
    assert.deepEqual(
      domainAsset().root.children.map((c) => c.props['text']),
      ['甲', '乙', '丙'],
      '一次撤销全部还原（各自原值）',
    )

    // vec2 增量合并：批量改 X 不覆盖各自 Y
    const posRow = findRow('位置')!
    const xInput = posRow.querySelectorAll<HTMLInputElement>('input[type=number]')[0]!
    assert.equal(xInput.getAttribute('placeholder'), '—', '位置混合态')
    act(() => setControlledValue(xInput, '9'))
    act(() => pressEnter(xInput))
    assert.deepEqual(
      domainAsset().root.children.map((c) => c.transform.position),
      [
        { x: 9, y: 10 },
        { x: 9, y: 20 },
        { x: 9, y: 30 },
      ],
      'X 批量更新、Y 各自保留',
    )
    assert.equal(peekUndo()?.label, '检视器：批量修改 位置 3 个')
    doUndo()
    assert.deepEqual(domainAsset().root.children[0]!.transform.position, { x: 1, y: 10 }, 'undo 还原位置')

    // 多选共同属性交集：非共同属性不显示（三个 label 全同型 → 全部属性；
    // 混型场景在 intersectPropDefs 单测覆盖，这里验证 label+button 不显示 text/variant）
  } finally {
    await unmount()
  }

  // 跨类型多选：只显示共同属性
  dom.document.body.innerHTML = ''
  const root2 = uiNode('panel2', 'panel', '面板', {}, [
    uiNode('l1', 'label', 'L1'),
    uiNode('b1', 'button', 'B1'),
  ])
  openAsset(root2)
  useUIEditorStore.getState().setSelection(['l1', 'b1'])
  const second = await mountEl(createElement(InspectorPanel, {}))
  try {
    const labels = Array.from(dom.document.querySelectorAll('.insp-label')).map((el) => el.textContent)
    // label 与 button 的 text 声明一致（string/内容）→ 属于共同属性；非共同的是 wrap / variant
    assert.equal(labels.includes('自动换行'), false, '非共同属性 wrap 不显示')
    assert.equal(labels.includes('样式变体'), false, '非共同属性 variant 不显示')
    assert.deepEqual(
      labels,
      ['名称', '可见', '悬停提示', '位置', '尺寸', '旋转', '拉伸填充', '文本'],
      '只显示共同属性（组内按声明序、组间按 PROP_GROUP_ORDER）',
    )
  } finally {
    await second.unmount()
  }
})

test('面板：listColumns 校验错误就地显示且不入栈，合法值提交', async () => {
  dom.document.body.innerHTML = ''
  openAsset(uiNode('lst', 'list', '列表'))
  useUIEditorStore.getState().setSelection(['lst'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    const row = findRow('列定义')!
    const textarea = row.querySelector<HTMLTextAreaElement>('textarea')!

    // 非法 JSON → 错误提示 + 不入栈
    act(() => setControlledValue(textarea, '{oops'))
    act(() => blurEl(textarea))
    assert.match(dom.document.querySelector('.insp-error')?.textContent ?? '', /JSON 解析失败/)
    assert.equal(peekUndo()?.label, '打开 UI', '非法值不入栈')

    // 合法 JSON → 提交入栈
    const next = JSON.stringify([{ field: 'name', title: '名称' }])
    act(() => setControlledValue(textarea, next))
    act(() => blurEl(textarea))
    assert.equal(dom.document.querySelector('.insp-error'), null, '合法值清除错误')
    assert.equal(peekUndo()?.label, '检视器：列定义')
    const cols = domainAsset().root.props['columns'] as ListColumn[]
    assert.equal(cols.length, 1)
    assert.equal(cols[0]!.field, 'name')
    doUndo()
    assert.equal(((domainAsset().root.props['columns'] as ListColumn[]) ?? []).length, 2, 'undo 还原默认列定义')
  } finally {
    await unmount()
  }
})

test('runUICommand 空配方不入栈（同值提交不产生命令）', async () => {
  dom.document.body.innerHTML = ''
  openAsset(uiNode('lab', 'label', '标签', { text: '原始' }))
  useUIEditorStore.getState().setSelection(['lab'])
  const { unmount } = await mountEl(createElement(InspectorPanel, {}))
  try {
    const input = findRow('文本')!.querySelector<HTMLInputElement>('input[type=text]')!
    act(() => setControlledValue(input, '原始')) // 与现值相同
    act(() => pressEnter(input))
    assert.equal(peekUndo()?.label, '打开 UI', '同值提交不产生命令')
  } finally {
    await unmount()
  }
})
