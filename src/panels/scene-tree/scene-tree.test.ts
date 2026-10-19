/**
 * UI 树面板测试（T1.4 DoD）
 *
 * 覆盖（任务卡单测清单 1–5）：
 * 1. 树纯函数：扁平化（展开集 / 深度 / 叶子标记）、name 去重（" (n)" 后缀 / 大小写不敏感 /
 *    自身排除）、拖拽落点合法性（自身 / 子树 / 叶子拒子 / 根不可移动与两侧拒插）、root 不可删；
 * 2. 移动命令三种落区（before / after / inside）资产变化 + undo 还原（真实命令栈，
 *    label「树：移动节点」；空配方不入栈）；
 * 3. 复制子树：全新 id + name「xxx (2)」去重 + 深拷贝独立（改源不影响副本）+ undo；
 * 4. 删除子树 + undo；添加节点 defaultProps / transform 拆分 / name 唯一（label「树：添加节点」）；
 * 5. 组件冒烟：happy-dom 挂载 SceneTreePanel（runCommand 注入 asset）——
 *    空态文案、行数、右键（根=添加浮层 / 节点=通用菜单+复制/删除）、选中联动（点击与
 *    store setSelection → selected 类 + scrollIntoView）、双击行内重命名（成功入栈 / 重名拒绝）、
 *    拖拽重排（before 落区移动 + undo 还原；叶子 inside 拒绝）。
 *
 * 运行：npx tsx --test src/panels/scene-tree/scene-tree.test.ts
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { UIAsset, UINode } from '../../ir/types'
import type { SceneTreeDomainState } from '../../ui-editor/store'

/* ── happy-dom 环境注入（组件挂载用；与 viewport.test.ts 同款桥接）──────── */
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
  'PointerEvent',
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
const treeModel = await import('./tree-model')
const cmd = await import('./commands')
const { getSceneTreeDomain, useUIEditorStore } = await import('../../ui-editor/store')
const { registerDomainState, runCommand, resetEditorStore, undo, redo, peekUndo, useEditorStore } =
  await import('../../shell/commands')
const { defaultPropsFor, getUISchema } = await import('../../ui-editor/schema')
const { SceneTreePanel } = await import('./SceneTreePanel')

/* ============================================================
 * 构造辅助
 * ============================================================ */

let seq = 0

/** 按 schema 默认值构造 UINode（公共 name/position/size/rotation 拆入顶层与 transform） */
function makeNode(
  type: string,
  opt: {
    id?: string
    name?: string
    children?: UINode[]
  } = {},
): UINode {
  const all = defaultPropsFor(type)
  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(all)) {
    if (k === 'name' || k === 'position' || k === 'size' || k === 'rotation') continue
    props[k] = v
  }
  const pos = all.position as { x: number; y: number }
  const size = all.size as { w: number; h: number }
  return {
    id: opt.id ?? `n${++seq}`,
    name: opt.name ?? String(all.name ?? type),
    type,
    transform: {
      position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
      size: { w: size?.w ?? 0, h: size?.h ?? 0 },
      rotation: (all.rotation as number) ?? 0,
    },
    theme: {},
    props,
    events: [],
    children: opt.children ?? [],
  }
}

/**
 * 样例资产：
 * root(panel 自由容器)
 *   ├─ a(button「button」)
 *   ├─ box(vbox「box」) ── c(label「label」)
 *   └─ b(button「button2」)
 */
function makeAsset(): UIAsset {
  return {
    version: 2,
    name: '测试 UI',
    root: makeNode('panel', {
      id: 'root',
      name: 'root',
      children: [
        makeNode('button', { id: 'a', name: 'button' }),
        makeNode('vbox', { id: 'box', name: 'box', children: [makeNode('label', { id: 'c', name: 'label' })] }),
        makeNode('button', { id: 'b', name: 'button2' }),
      ],
    }),
  }
}

/** 重置命令栈 + 注入 scene-tree 域资产（组件冒烟与命令测试的 store 通路） */
function initDomain(asset: UIAsset | null = null): void {
  resetEditorStore()
  // 先经 store 自己的 ensureDomain 挂域（置内部 domainRegistered 标志，
  // 避免后续 runUICommand 再次 registerDomainState 把注入的资产冲掉）
  void getSceneTreeDomain()
  registerDomainState<SceneTreeDomainState>('scene-tree', { asset: null })
  if (asset) {
    runCommand<SceneTreeDomainState>('scene-tree', '测试注入', (d) => {
      d.asset = asset
    })
  }
  // 注入本身是一条命令（同生产 openUIAsset 的「打开 UI」）：清栈让各测试从零基线开始
  useEditorStore.setState({ undoStack: [], redoStack: [], lastReplay: null })
  useUIEditorStore.setState({
    projectPath: '测试项目',
    assetPath: 'ui/test.ui.json',
    status: asset ? 'ready' : 'idle',
    message: '',
    selection: [],
  })
}

/* —— happy-dom 桥接 —— */

interface RectStub {
  left: number
  top: number
  width: number
  height: number
}

/** 覆盖元素的 getBoundingClientRect（拖拽落区计算 / 视口钳位的真实数据通路） */
function stubRect(el: Element | null | undefined, r: RectStub): void {
  assert.ok(el, 'stubRect：目标元素不存在')
  ;(el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON() {
      return this
    },
  })
}

function q(selector: string): HTMLElement {
  const el = dom.document.querySelector(selector)
  assert.ok(el, `未找到元素 ${selector}`)
  return el as unknown as HTMLElement
}

function all(selector: string): HTMLElement[] {
  return [...dom.document.querySelectorAll(selector)] as unknown as HTMLElement[]
}

function byNodeId(id: string): HTMLElement {
  const el = dom.document.querySelector(`[data-node-id="${id}"]`)
  assert.ok(el, `未找到 data-node-id="${id}" 的行`)
  return el as unknown as HTMLElement
}

/** 挂载 SceneTreePanel（act 内 render；返回卸载函数） */
async function mountPanel(): Promise<{ unmount: () => Promise<void> }> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => {
    root.render(createElement(SceneTreePanel))
  })
  return {
    unmount: () =>
      act(async () => {
        root.unmount()
        container.remove()
      }),
  }
}

function mouse(el: HTMLElement, type: string, extra: Record<string, unknown> = {}): void {
  act(() => {
    el.dispatchEvent(
      new dom.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...extra,
      } as never) as unknown as Event,
    )
  })
}

function dragEvent(el: HTMLElement, type: string, extra: Record<string, unknown> = {}): void {
  const ev = new dom.Event(type, { bubbles: true, cancelable: true })
  const dt = {
    types: ['text/plain'],
    setData: () => {},
    effectAllowed: '',
    dropEffect: '',
  }
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  Object.defineProperty(ev, 'clientX', { value: extra.clientX ?? 0 })
  Object.defineProperty(ev, 'clientY', { value: extra.clientY ?? 0 })
  act(() => {
    el.dispatchEvent(ev as unknown as Event)
  })
}

/** React 受控输入框设值（native setter + input 事件，绕过 React 值追踪去重） */
function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  act(() => {
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
  })
}

function keyOn(el: HTMLElement, keyName: string): void {
  act(() => {
    el.dispatchEvent(
      new dom.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true } as never) as unknown as Event,
    )
  })
}

/** 根子节点 id 顺序 */
function rootChildIds(asset = getSceneTreeDomain().asset!): string[] {
  return asset.root.children.map((c) => c.id)
}

beforeEach(() => {
  initDomain()
})

/* ============================================================
 * 1. 树纯函数
 * ============================================================ */

describe('树纯函数', () => {
  it('flattenTree：按展开集输出行（根常驻 / 缩进深度 / 叶子标记）', () => {
    const asset = makeAsset()
    const root = asset.root
    // 仅展开根：root / a / box / b 四行（c 藏在 box 内）
    const rows1 = treeModel.flattenTree(root, new Set(['root']))
    assert.deepEqual(
      rows1.map((r) => r.node.id),
      ['root', 'a', 'box', 'b'],
    )
    assert.deepEqual(
      rows1.map((r) => r.depth),
      [0, 1, 1, 1],
    )
    assert.equal(rows1[0].parent, null)
    assert.equal(rows1[1].parent, root)
    assert.deepEqual(rows1.map((r) => r.hasChildren), [true, false, true, false])
    // 展开 box：c 出现，深度 2
    const rows2 = treeModel.flattenTree(root, new Set(['root', 'box']))
    assert.deepEqual(
      rows2.map((r) => r.node.id),
      ['root', 'a', 'box', 'c', 'b'],
    )
    assert.equal(rows2[3].depth, 2)
    assert.equal(rows2[3].parent, root.children[1])
  })

  it('dedupeNodeName：重名追加 " (n)"（大小写不敏感 / 连续去重），无冲突原样返回', () => {
    const taken = new Set(['button', 'box'])
    assert.equal(treeModel.dedupeNodeName(taken, 'label'), 'label')
    assert.equal(treeModel.dedupeNodeName(taken, 'button'), 'button (2)')
    taken.add('button (2)')
    assert.equal(treeModel.dedupeNodeName(taken, 'button'), 'button (3)')
    // 大小写不敏感判定冲突
    assert.equal(treeModel.dedupeNodeName(new Set(['Button']), 'button'), 'button (2)')
  })

  it('isNameAvailable / collectTreeNames：树内唯一名（排除自身旧名）', () => {
    const root = makeAsset().root
    assert.equal(treeModel.isNameAvailable(root, 'button2', 'a'), false) // b 已占用
    assert.equal(treeModel.isNameAvailable(root, 'button', 'a'), true) // 自身旧名排除
    assert.equal(treeModel.isNameAvailable(root, '  ', 'a'), false) // 空名
    assert.deepEqual([...treeModel.collectTreeNames(root)].sort(), ['box', 'button', 'button2', 'label', 'root'])
  })

  it('checkDrop：自身 / 子树 / 叶子拒子 / 根约束 全部拒绝并给中文原因', () => {
    const root = makeAsset().root
    // 拖到自身（三种落区）
    for (const zone of ['before', 'after', 'inside'] as const) {
      const r = treeModel.checkDrop(root, 'a', 'a', zone)
      assert.equal(r.ok, false)
      assert.match(r.reason!, /自身/)
    }
    // 拖到自身子树内（box → c）
    for (const zone of ['before', 'after', 'inside'] as const) {
      const r = treeModel.checkDrop(root, 'box', 'c', zone)
      assert.equal(r.ok, false)
      assert.match(r.reason!, /子树/)
    }
    // 叶子拒子（label defaultChildPolicy 'none'）
    const leaf = treeModel.checkDrop(root, 'a', 'c', 'inside')
    assert.equal(leaf.ok, false)
    assert.match(leaf.reason!, /叶子/)
    // 根不可移动
    assert.equal(treeModel.checkDrop(root, 'root', 'a', 'before').ok, false)
    // 根两侧不可插（before/after 目标为根）
    assert.equal(treeModel.checkDrop(root, 'a', 'root', 'before').ok, false)
    assert.equal(treeModel.checkDrop(root, 'a', 'root', 'after').ok, false)
    // 根内部可插（合法落区）
    assert.equal(treeModel.checkDrop(root, 'a', 'root', 'inside').ok, true)
    // 合法：兄弟排序 / 跨父移动 / 容器 inside
    assert.equal(treeModel.checkDrop(root, 'b', 'a', 'before').ok, true)
    assert.equal(treeModel.checkDrop(root, 'a', 'box', 'inside').ok, true)
    assert.equal(treeModel.checkDrop(root, 'c', 'b', 'after').ok, true)
  })

  it('moveUINode：就地移动三种落区（兄弟位移自动修正 / 非法拒绝）', () => {
    const root = makeAsset().root
    // before：b 移到 a 上方 → [b, a, box]
    assert.equal(treeModel.moveUINode(root, 'b', 'a', 'before'), true)
    assert.deepEqual(root.children.map((c) => c.id), ['b', 'a', 'box'])
    // inside：a 移入 box → [b, box[c, a]]
    assert.equal(treeModel.moveUINode(root, 'a', 'box', 'inside'), true)
    assert.deepEqual(root.children.map((c) => c.id), ['b', 'box'])
    assert.deepEqual(root.children[1].children.map((c) => c.id), ['c', 'a'])
    // 子树拒绝：把 box 移到其子节点 c 上方
    assert.equal(treeModel.moveUINode(root, 'box', 'c', 'before'), false)
    // 结构未被污染
    assert.deepEqual(root.children.map((c) => c.id), ['b', 'box'])
    assert.deepEqual(root.children[1].children.map((c) => c.id), ['c', 'a'])
  })

  it('removeUINode：删除含子树并返回被摘除子树；root 不可删', () => {
    const root = makeAsset().root
    assert.equal(treeModel.removeUINode(root, 'root'), null) // root 不可删
    const removed = treeModel.removeUINode(root, 'box')
    assert.ok(removed)
    assert.equal(removed.id, 'box')
    assert.deepEqual(root.children.map((c) => c.id), ['a', 'b'])
    assert.equal(treeModel.removeUINode(root, 'ghost'), null)
  })

  it('buildUINode：defaultPropsFor 拆分（transform / props）+ name 去重', () => {
    const taken = new Set(['button'])
    const node = treeModel.buildUINode('button', taken, 'n_new')
    assert.ok(node)
    assert.equal(node.id, 'n_new')
    assert.equal(node.name, 'button (2)') // 与 schema 初值冲突 → 去重
    assert.deepEqual(node.transform.size, getUISchema('button')!.props.find((p) => p.id === 'size')!.default)
    assert.deepEqual(node.transform.position, { x: 0, y: 0 })
    assert.equal(node.children.length, 0)
    assert.equal(node.theme && Object.keys(node.theme).length, 0)
    // v3 T11.1：业务属性默认值不再物化（渲染/检视解析器兜底），保证样式类可覆盖
    assert.deepEqual(node.props, {})
    // 未知类型
    assert.equal(treeModel.buildUINode('ghost', taken), null)
    // 无冲突时用 schema 初值（类型名）
    assert.equal(treeModel.buildUINode('label', new Set())!.name, 'label')
  })

  it('cloneSubtree：全新 id + name 顺序去重 + 深拷贝独立', () => {
    const root = makeAsset().root
    const box = root.children[1]
    const taken = treeModel.collectTreeNames(root)
    const before = JSON.stringify(box)
    const clone = treeModel.cloneSubtree(box, taken)
    // 深拷贝：源未被引用（独立 JSON）
    assert.notEqual(JSON.stringify(box), JSON.stringify(clone))
    assert.equal(JSON.stringify(box), before)
    // 全新 id（与源树全部不同）
    const sourceIds = new Set(['root', 'a', 'box', 'c', 'b'])
    const cloneIds = ['box', 'c'].map(() => '')
    void cloneIds
    for (const n of [clone, ...clone.children]) assert.equal(sourceIds.has(n.id), false)
    // name 去重（box → box (2)，c → label (2)）
    assert.equal(clone.name, 'box (2)')
    assert.equal(clone.children[0].name, 'label (2)')
  })

  it('ancestorIds / findUINodeById / findWithParent：查找工具', () => {
    const root = makeAsset().root
    assert.deepEqual(treeModel.ancestorIds(root, 'c'), ['root', 'box'])
    assert.deepEqual(treeModel.ancestorIds(root, 'root'), [])
    assert.deepEqual(treeModel.ancestorIds(root, 'ghost'), [])
    assert.equal(treeModel.findUINodeById(root, 'c')?.id, 'c')
    assert.equal(treeModel.findUINodeById(root, 'ghost'), null)
    assert.equal(treeModel.findWithParent(root, 'c')?.parent?.id, 'box')
    assert.equal(treeModel.findWithParent(root, 'root')?.parent, null)
  })
})

/* ============================================================
 * 2. 移动命令三种落区 + undo 还原
 * ============================================================ */

describe('移动命令（树：移动节点）', () => {
  it('before：移到目标上方；undo 还原顺序', () => {
    initDomain(makeAsset())
    assert.equal(cmd.moveUINodeCommand('b', 'a', 'before'), true)
    assert.deepEqual(rootChildIds(), ['b', 'a', 'box'])
    assert.equal(peekUndo()?.label, '树：移动节点')
    undo()
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
  })

  it('after：移到目标下方；undo / redo 双向还原', () => {
    initDomain(makeAsset())
    assert.equal(cmd.moveUINodeCommand('a', 'b', 'after'), true)
    assert.deepEqual(rootChildIds(), ['box', 'b', 'a'])
    undo()
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
    redo()
    assert.deepEqual(rootChildIds(), ['box', 'b', 'a'])
  })

  it('inside：成为目标子节点；undo 还原父子', () => {
    initDomain(makeAsset())
    assert.equal(cmd.moveUINodeCommand('a', 'box', 'inside'), true)
    const asset = getSceneTreeDomain().asset!
    assert.deepEqual(asset.root.children.map((c) => c.id), ['box', 'b'])
    assert.deepEqual(asset.root.children[0].children.map((c) => c.id), ['c', 'a'])
    undo()
    const restored = getSceneTreeDomain().asset!
    assert.deepEqual(restored.root.children.map((c) => c.id), ['a', 'box', 'b'])
    assert.deepEqual(restored.root.children[1].children.map((c) => c.id), ['c'])
  })

  it('非法落点不发命令：自身 / 子树 / 叶子拒子 / 根拖拽', () => {
    initDomain(makeAsset())
    assert.equal(cmd.moveUINodeCommand('a', 'a', 'inside'), false)
    assert.equal(cmd.moveUINodeCommand('box', 'c', 'before'), false)
    assert.equal(cmd.moveUINodeCommand('a', 'c', 'inside'), false)
    assert.equal(cmd.moveUINodeCommand('root', 'a', 'before'), false)
    assert.equal(cmd.moveUINodeCommand('a', 'root', 'after'), false)
    assert.equal(peekUndo(), null) // 栈干净
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
  })
})

/* ============================================================
 * 3. 复制子树
 * ============================================================ */

describe('复制子树（树：复制节点）', () => {
  it('全新 id + name「xxx (2)」去重 + 插到源节点之后', () => {
    initDomain(makeAsset())
    const newId = cmd.duplicateUINodeCommand('box')
    assert.ok(newId && newId !== 'box')
    const asset = getSceneTreeDomain().asset!
    assert.deepEqual(rootChildIds(), ['a', 'box', newId, 'b'])
    const copy = asset.root.children[2]
    assert.equal(copy.name, 'box (2)')
    assert.equal(copy.children[0].name, 'label (2)')
    // 全树 id 唯一
    const ids = new Set(['root', 'a', 'box', 'c', 'b', newId, copy.children[0].id])
    assert.equal(ids.size, 7)
    assert.equal(peekUndo()?.label, '树：复制节点 box')
  })

  it('深拷贝独立：副本与源节点互不影响', () => {
    initDomain(makeAsset())
    const newId = cmd.duplicateUINodeCommand('box')!
    const asset = getSceneTreeDomain().asset!
    const copy = asset.root.children.find((c) => c.id === newId)!
    const source = asset.root.children.find((c) => c.id === 'box')!
    // 对象身份独立（深拷贝，非引用）
    assert.notEqual(copy, source)
    assert.notEqual(copy.children[0], source.children[0])
    // 值一致（拷贝发生时）
    assert.equal(JSON.stringify(copy.transform), JSON.stringify(source.transform))
    // 复制后修改源子节点名 → 副本不受影响
    cmd.renameUINodeCommand('c', 'renamed')
    const asset2 = getSceneTreeDomain().asset!
    assert.equal(asset2.root.children.find((c) => c.id === newId)!.children[0].name, 'label (2)')
    assert.equal(asset2.root.children.find((c) => c.id === 'box')!.children[0].name, 'renamed')
  })

  it('undo 撤销复制；根节点不可复制', () => {
    initDomain(makeAsset())
    const newId = cmd.duplicateUINodeCommand('a')
    assert.ok(newId)
    assert.deepEqual(rootChildIds(), ['a', newId, 'box', 'b'])
    undo()
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
    assert.equal(cmd.duplicateUINodeCommand('root'), null)
  })
})

/* ============================================================
 * 4. 删除子树 + undo；添加节点
 * ============================================================ */

describe('删除与添加', () => {
  it('删除子树：含子节点整体移除 + undo 还原', () => {
    initDomain(makeAsset())
    assert.equal(cmd.deleteUINodeCommand('box'), true)
    assert.deepEqual(rootChildIds(), ['a', 'b'])
    assert.equal(getSceneTreeDomain().asset!.root.children.some((c) => c.id === 'c'), false)
    assert.equal(peekUndo()?.label, '树：删除节点 box')
    undo()
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
    assert.equal(getSceneTreeDomain().asset!.root.children[1].children[0].id, 'c')
  })

  it('根节点不可删除；不存在节点返回 false', () => {
    initDomain(makeAsset())
    assert.equal(cmd.deleteUINodeCommand('root'), false)
    assert.equal(cmd.deleteUINodeCommand('ghost'), false)
    assert.equal(peekUndo(), null)
  })

  it('添加节点：defaultProps + name 唯一 + 插为父级子节点', () => {
    initDomain(makeAsset())
    const newId = cmd.addUINodeCommand('button', 'root')
    assert.ok(newId && newId.startsWith('n_'))
    const asset = getSceneTreeDomain().asset!
    const node = asset.root.children.find((c) => c.id === newId)!
    assert.equal(node.name, 'button (2)') // 与 a「button」冲突 → 去重
    assert.equal(node.type, 'button')
    assert.equal(node.children.length, 0)
    assert.deepEqual(node.transform.size, getUISchema('button')!.props.find((p) => p.id === 'size')!.default)
    assert.deepEqual(node.props, {}, '业务属性默认值由渲染/检视解析器补齐')
    assert.equal(peekUndo()?.label, '树：添加节点 按钮')
    // 添加进容器
    const id2 = cmd.addUINodeCommand('button', 'box')
    assert.ok(id2)
    assert.equal(getSceneTreeDomain().asset!.root.children[1].children.some((c) => c.id === id2), true)
  })

  it('添加节点：未知类型 / 无资产返回 null', () => {
    initDomain(makeAsset())
    assert.equal(cmd.addUINodeCommand('ghost', 'root'), null)
    initDomain(null)
    assert.equal(cmd.addUINodeCommand('button', 'root'), null)
  })

  it('重命名：成功入栈「树：重命名节点」+ undo；重名 / 空名拒绝', () => {
    initDomain(makeAsset())
    assert.equal(cmd.renameUINodeCommand('a', 'button2'), 'duplicate') // 与 b 冲突
    assert.equal(cmd.renameUINodeCommand('a', '  '), 'empty')
    assert.equal(cmd.renameUINodeCommand('a', 'button'), 'ok') // 与原名相同：无变化
    assert.equal(peekUndo(), null)
    assert.equal(cmd.renameUINodeCommand('a', '主按钮'), 'ok')
    assert.equal(getSceneTreeDomain().asset!.root.children[0].name, '主按钮')
    assert.equal(peekUndo()?.label, '树：重命名节点')
    undo()
    assert.equal(getSceneTreeDomain().asset!.root.children[0].name, 'button')
  })
})

/* ============================================================
 * 5. 组件冒烟（happy-dom 挂载）
 * ============================================================ */

describe('组件冒烟（SceneTreePanel）', () => {
  it('空态：未打开 UI 提示文案', async () => {
    initDomain(null)
    const { unmount } = await mountPanel()
    assert.match(dom.document.body.textContent ?? '', /未打开 UI（文件面板双击 \.ui\.json）/)
    await unmount()
  })

  it('行数与缩进：默认展开根，chevron 展开容器', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    // root / a / box / b（c 藏在折叠的 box 内）
    assert.equal(all('[data-node-id]').length, 4)
    // 展开 box → c 出现
    const chevron = byNodeId('box').querySelector('.st-chevron') as HTMLElement
    assert.ok(chevron, 'box 行有 chevron')
    await act(async () => {
      chevron.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    assert.equal(all('[data-node-id]').length, 5)
    assert.ok(byNodeId('c'), 'c 行出现')
    // 折叠回去
    const chevron2 = byNodeId('box').querySelector('.st-chevron') as HTMLElement
    await act(async () => {
      chevron2.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    assert.equal(all('[data-node-id]').length, 4)
    await unmount()
  })

  it('行内容：icon + name + 类型小字', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    const row = byNodeId('a')
    assert.ok(row.querySelector('.st-icon svg'), '行图标渲染为 Lucide 图标')
    assert.equal(row.querySelector('.st-name')?.textContent, 'button')
    assert.equal(row.querySelector('.st-type')?.textContent, '按钮')
    await unmount()
  })

  it('点击选中：写入 store.selection；根行右键弹添加浮层（内联搜索 + 分类分组）', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    // 点击 a → 选中
    mouse(byNodeId('a'), 'click')
    assert.deepEqual(useUIEditorStore.getState().selection, ['a'])
    assert.match(byNodeId('a').className, /selected/)
    // 根行右键 → 添加节点浮层（不是通用菜单）
    mouse(byNodeId('root'), 'contextmenu', { button: 2, clientX: 10, clientY: 10 })
    const addmenu = q('.st-addmenu')
    assert.ok(addmenu.querySelector('.st-addmenu-search'), '有内联搜索框')
    const groupTitles = all('.st-addmenu-group').map((g) => g.textContent)
    assert.deepEqual(groupTitles, ['容器', '显示', '输入', '数据'])
    // 搜索过滤
    setControlledValue(addmenu.querySelector('.st-addmenu-search') as HTMLInputElement, 'btn')
    const items = all('.st-addmenu-item')
    assert.equal(items.length, 1)
    assert.equal(items[0].textContent?.includes('按钮'), true)
    // 点击 → 添加为 root 子节点（name 去重）
    await act(async () => {
      items[0].dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    const ids = rootChildIds()
    assert.equal(ids.length, 4) // a / box / b / 新节点
    const newNode = getSceneTreeDomain().asset!.root.children[3]
    assert.equal(newNode.name, 'button (2)')
    assert.equal(peekUndo()?.label, '树：添加节点 按钮')
    assert.deepEqual(useUIEditorStore.getState().selection, [newNode.id])
    assert.equal(dom.document.querySelector('.st-addmenu'), null, '选中后浮层关闭')
    await unmount()
  })

  it('节点右键菜单：复制 / 删除 / 附加逻辑资产占位', async () => {
    // confirm 桩（删除确认）
    (dom.window as unknown as { confirm: (m?: string) => boolean }).confirm = () => true
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    // 子节点右键 → 通用 Menu
    mouse(byNodeId('a'), 'contextmenu', { button: 2, clientX: 10, clientY: 10 })
    assert.ok(q('.fs-menu'), '通用菜单已打开')
    const labels = all('.fs-menu-item').map((b) => b.textContent)
    assert.equal(labels.some((t) => t?.includes('复制')), true)
    assert.equal(labels.some((t) => t?.includes('重命名')), true)
    assert.equal(labels.some((t) => t?.includes('删除')), true)
    assert.equal(labels.some((t) => t?.includes('T2.6')), false)
    // button 是叶子：添加子节点置灰
    const addItem = all('.fs-menu-item').find((b) => b.textContent?.includes('添加子节点'))
    assert.ok(addItem)
    assert.equal((addItem as HTMLButtonElement).disabled, true)
    // 附加逻辑资产 → toast 占位
    await act(async () => {
      all('.fs-menu-item')
        .find((b) => b.textContent?.includes('附加逻辑资产'))!
        .dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    assert.match(q('.st-toast').textContent ?? '', /T2\.6 接入/)
    // 复制 → 新节点「button (2)」插到 a 之后并选中
    mouse(byNodeId('a'), 'contextmenu', { button: 2, clientX: 10, clientY: 10 })
    await act(async () => {
      all('.fs-menu-item')
        .find((b) => b.textContent?.includes('复制'))!
        .dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    const ids = rootChildIds()
    assert.deepEqual(ids, ['a', ids[1], 'box', 'b'])
    assert.equal(getSceneTreeDomain().asset!.root.children[1].name, 'button (2)')
    // 删除 box → confirm 文案含子节点数，子树整体移除
    mouse(byNodeId('box'), 'contextmenu', { button: 2, clientX: 10, clientY: 10 })
    await act(async () => {
      all('.fs-menu-item')
        .find((b) => b.textContent?.includes('删除'))!
        .dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    assert.deepEqual(rootChildIds(), ['a', ids[1], 'b'])
    // undo 恢复删除
    await act(async () => {
      undo()
    })
    assert.deepEqual(rootChildIds(), ['a', ids[1], 'box', 'b'])
    await unmount()
  })

  it('选中联动：store setSelection（视口侧）→ 展开祖先 + selected 类 + scrollIntoView', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    // c 在折叠的 box 内：setSelection → 自动展开祖先并渲染选中行
    await act(async () => {
      useUIEditorStore.getState().setSelection(['c'])
    })
    assert.ok(byNodeId('c'), 'c 行已展开渲染')
    assert.match(byNodeId('c').className, /selected/)
    assert.deepEqual(useUIEditorStore.getState().selection, ['c'])
    // scrollIntoView：桩 c 行后换选 a 再选回 c（deps 变化强制联动 effect 重跑）
    let scrolled = 0
    const row = byNodeId('c')
    ;(row as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {
      scrolled++
    }
    await act(async () => {
      useUIEditorStore.getState().setSelection(['a'])
    })
    await act(async () => {
      useUIEditorStore.getState().setSelection(['c'])
    })
    assert.equal(scrolled >= 1, true, 'scrollIntoView 被调用')
    await unmount()
  })

  it('双击行内重命名：成功入栈；重名拒绝中文提示', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    // 双击 a → 行内输入框
    mouse(byNodeId('a'), 'dblclick')
    const input = q('[data-node-id="a"] .st-rename-input') as HTMLInputElement
    assert.equal(input.value, 'button')
    // 重名拒绝：button2 已被 b 占用
    setControlledValue(input, 'button2')
    keyOn(input, 'Enter')
    assert.match(q('.st-toast').textContent ?? '', /已存在/)
    assert.equal(getSceneTreeDomain().asset!.root.children[0].name, 'button')
    // 保留编辑态，改名成功
    const input2 = q('[data-node-id="a"] .st-rename-input') as HTMLInputElement
    setControlledValue(input2, '主按钮')
    keyOn(input2, 'Enter')
    assert.equal(getSceneTreeDomain().asset!.root.children[0].name, '主按钮')
    assert.equal(peekUndo()?.label, '树：重命名节点')
    await act(async () => {
      undo()
    })
    assert.equal(getSceneTreeDomain().asset!.root.children[0].name, 'button')
    // Esc 取消
    mouse(byNodeId('a'), 'dblclick')
    keyOn(q('[data-node-id="a"] .st-rename-input'), 'Escape')
    assert.equal(dom.document.querySelector('[data-node-id="a"] .st-rename-input'), null)
    await unmount()
  })

  it('拖拽重排：before 落区移动入栈 + undo 还原；inside 落区 / 叶子钳位', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    // 行矩形桩：各行 24px 高，纵向排列（root/a/box/b）
    ;(['root', 'a', 'box', 'b'] as const).forEach((id, i) =>
      stubRect(byNodeId(id), { left: 0, top: i * 24, width: 200, height: 24 }),
    )
    // 拖 b 悬停 a 上缘（before 落区）→ 落下移到 a 上方
    dragEvent(byNodeId('b'), 'dragstart')
    dragEvent(byNodeId('a'), 'dragover', { clientY: 24 * 1 + 2 })
    assert.match(byNodeId('a').className, /drop-before/, '上方插入指示')
    dragEvent(byNodeId('a'), 'drop', { clientY: 24 * 1 + 2 })
    assert.deepEqual(rootChildIds(), ['b', 'a', 'box'])
    assert.equal(peekUndo()?.label, '树：移动节点')
    await act(async () => {
      undo()
    })
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
    // 拖 a 到 box 中带 → inside 成为其子节点（落下后自动展开）
    dragEvent(byNodeId('a'), 'dragstart')
    dragEvent(byNodeId('box'), 'dragover', { clientY: 24 * 2 + 12 })
    assert.match(byNodeId('box').className, /drop-inside/, '内部落区指示')
    dragEvent(byNodeId('box'), 'drop', { clientY: 24 * 2 + 12 })
    const asset = getSceneTreeDomain().asset!
    assert.equal(asset.root.children[0].id, 'box')
    assert.deepEqual(asset.root.children[0].children.map((c) => c.id), ['c', 'a'])
    await act(async () => {
      undo()
    })
    // 拖 b 到 leaf 行（button）中带 → inside 非法钳位为 before（不出现 inside 指示）
    dragEvent(byNodeId('b'), 'dragstart')
    dragEvent(byNodeId('a'), 'dragover', { clientY: 24 * 1 + 12 })
    assert.equal(/drop-inside/.test(byNodeId('a').className), false, '叶子不出现 inside 指示')
    assert.match(byNodeId('a').className, /drop-before/, '叶子中带钳位为 before')
    dragEvent(byNodeId('a'), 'drop', { clientY: 24 * 1 + 12 })
    assert.deepEqual(rootChildIds(), ['b', 'a', 'box'])
    await act(async () => {
      undo()
    })
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
    await unmount()
  })

  it('拖到自身：无落区指示、drop 不产生命令', async () => {
    initDomain(makeAsset())
    const { unmount } = await mountPanel()
    stubRect(byNodeId('root'), { left: 0, top: 0, width: 200, height: 24 })
    stubRect(byNodeId('a'), { left: 0, top: 24, width: 200, height: 24 })
    dragEvent(byNodeId('a'), 'dragstart')
    dragEvent(byNodeId('a'), 'dragover', { clientY: 24 })
    assert.equal(/drop-/.test(byNodeId('a').className), false)
    dragEvent(byNodeId('a'), 'drop', { clientY: 24 })
    assert.deepEqual(rootChildIds(), ['a', 'box', 'b'])
    assert.equal(peekUndo(), null)
    await unmount()
  })
})
