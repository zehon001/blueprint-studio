/**
 * Dock 外壳单元测试（T0.3 DoD）
 *
 * 覆盖：布局树纯函数（insertPanel 到边/中央、removePanel 剪枝、movePanel、
 * resizeSashSizes、序列化/反序列化、非法布局容错）、拖放落点判定、
 * dock store 动作与持久化、workspace-store 资产 tabs。
 * 组件交互逻辑已拆为上述可测纯函数（tree.ts / dropZone.ts）。
 *
 * 运行：npx tsx --test src/shell/dock/dock.test.ts
 */
import { before, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  activatePanelIn,
  findTabsByPanel,
  firstTabsGroup,
  getNodeAtPath,
  insertPanel,
  makeTabs,
  movePanel,
  normalizeDockNode,
  removePanel,
  resizeSashSizes,
  setGroupActive,
  MIN_PANE_PX,
  type DockNode,
  type DockTabsNode,
} from './tree'
import { computeDropSide } from './dropZone'
import {
  DOCK_LAYOUT_STORAGE_KEY,
  deserializeLayout,
  loadPersistedLayout,
  saveLayout,
  serializeLayout,
} from './persist'
import { useDockStore } from './store'

/* ---------------- 测试工具 ---------------- */

/** 统计 panelId 在树中出现次数（唯一不变式断言用） */
function countPanel(root: DockNode | null, panelId: string): number {
  if (!root) return 0
  if (root.kind === 'tabs') return root.panels.filter((p) => p === panelId).length
  return root.children.reduce((acc, c) => acc + countPanel(c, panelId), 0)
}

/** 构造单页 tabs 组 */
const t = (panelId: string): DockNode => makeTabs([panelId])

/** 取 tabs 组节点（断言辅助） */
function asTabs(node: DockNode | null): DockTabsNode {
  assert.ok(node && node.kind === 'tabs', `期望 tabs 节点，实得：${JSON.stringify(node)}`)
  return node
}

function asSplit(node: DockNode | null): Extract<DockNode, { kind: 'split' }> {
  assert.ok(node && node.kind === 'split', `期望 split 节点`)
  return node
}

/* ---------------- 插入 ---------------- */

describe('insertPanel：边插入', () => {
  it('空树边插入 → 单页 tabs 根', () => {
    const root = insertPanel(null, 'console', { kind: 'edge', side: 'left' })
    assert.deepEqual(asTabs(root).panels, ['console'])
  })

  it('tabs 根右缘插入 → 水平 split [原树, 新组]，新组占 1/4', () => {
    const base = t('a')
    const root = insertPanel(base, 'b', { kind: 'edge', side: 'right' })
    const split = asSplit(root)
    assert.equal(split.dir, 'h')
    assert.deepEqual(split.sizes, [3, 1])
    assert.deepEqual(asTabs(split.children[0]).panels, ['a'])
    assert.deepEqual(asTabs(split.children[1]).panels, ['b'])
  })

  it('tabs 根底缘插入 → 垂直 split [原树, 新组]', () => {
    const root = insertPanel(t('a'), 'b', { kind: 'edge', side: 'bottom' })
    const split = asSplit(root)
    assert.equal(split.dir, 'v')
    assert.deepEqual(split.sizes, [3, 1])
  })

  it('左缘/顶缘插入 → 新组在前', () => {
    for (const side of ['left', 'top'] as const) {
      const root = insertPanel(t('a'), 'b', { kind: 'edge', side })
      const split = asSplit(root)
      assert.deepEqual(asTabs(split.children[0]).panels, ['b'], side)
      assert.deepEqual(split.sizes, [1, 3], side)
    }
  })
})

describe('insertPanel：组（中央）插入', () => {
  it('并入指定 tabs 组并激活', () => {
    const split = asSplit({
      kind: 'split',
      dir: 'h',
      sizes: [1, 1],
      children: [t('a'), t('b')],
    })
    const groupB = asTabs(split.children[1])
    const root = insertPanel(split, 'c', { kind: 'group', groupId: groupB.id })
    const ref = findTabsByPanel(root, 'c')
    assert.ok(ref)
    assert.deepEqual(ref.node.panels, ['b', 'c'])
    assert.equal(ref.node.active, 1)
    assert.equal(countPanel(root, 'c'), 1)
  })

  it('组 id 悬空 → 退化为文档序第一个 tabs 组', () => {
    const root = insertPanel(t('a'), 'b', { kind: 'group', groupId: 'no-such-group' })
    const ref = findTabsByPanel(root, 'b')
    assert.ok(ref)
    assert.deepEqual(ref.node.panels, ['a', 'b'])
    assert.equal(firstTabsGroup(root)?.node.id, ref.node.id)
  })

  it('重复插入 → 树中唯一（幂等防御）', () => {
    const group = asTabs(t('a'))
    const root = insertPanel(t('a'), 'a', { kind: 'group', groupId: group.id })
    assert.equal(countPanel(root, 'a'), 1)
  })
})

/* ---------------- 移除 ---------------- */

describe('removePanel：移除与剪枝', () => {
  it('多页组移除：被移除页之后的激活页下标前移', () => {
    const tabs = makeTabs(['a', 'b', 'c'], 2) // 激活 c
    const root = removePanel(tabs, 'a')
    assert.deepEqual(asTabs(root).panels, ['b', 'c'])
    assert.equal(asTabs(root).active, 1)
  })

  it('空组剪枝：被剪权重并入其后的兄弟；split 仅剩一子时塌缩', () => {
    const root: DockNode = {
      kind: 'split',
      dir: 'h',
      sizes: [1, 2, 3],
      children: [t('a'), t('b'), t('c')],
    }
    const next = removePanel(root, 'a')
    const split = asSplit(next)
    assert.deepEqual(split.children.map((c) => asTabs(c).panels), [['b'], ['c']])
    assert.deepEqual(split.sizes, [3, 3]) // 1 + 2 → 并入原后兄弟

    const last = removePanel(root, 'c')
    assert.deepEqual(asSplit(last).sizes, [1, 5]) // 末位被剪 → 并入前一个
  })

  it('移除唯一面板 → 根为 null；嵌套时父 split 塌缩', () => {
    assert.equal(removePanel(t('a'), 'a'), null)
    const root: DockNode = { kind: 'split', dir: 'v', sizes: [1, 1], children: [t('a'), t('b')] }
    const next = removePanel(root, 'a')
    assert.deepEqual(asTabs(next).panels, ['b']) // split 单子塌缩
  })

  it('树中不含该面板 → 原样返回（引用相等）', () => {
    const root = t('a')
    assert.equal(removePanel(root, 'ghost'), root)
  })
})

/* ---------------- 移动 ---------------- */

describe('movePanel：拖放移动', () => {
  const buildThree = (): DockNode => ({
    kind: 'split',
    dir: 'h',
    sizes: [1, 1],
    children: [makeTabs(['a', 'b'], 0), t('q')],
  })

  it('跨组移动：源组保留他页、目标组追加并激活、树中唯一', () => {
    const root = buildThree()
    const groupQ = asSplit(root).children[1]
    const next = movePanel(root, 'a', { kind: 'group', groupId: asTabs(groupQ).id })
    const refA = findTabsByPanel(next, 'a')
    assert.ok(refA)
    assert.deepEqual(refA.node.panels, ['q', 'a'])
    assert.equal(refA.node.active, 1)
    assert.deepEqual(findTabsByPanel(next, 'b')?.node.panels, ['b'])
    assert.equal(countPanel(next, 'a'), 1)
  })

  it('并入自身所在组 → 结构不变，仅激活该页', () => {
    const root = buildThree()
    const groupAB = asSplit(root).children[0]
    const before = asTabs(groupAB)
    const next = movePanel(root, 'b', { kind: 'group', groupId: before.id })
    const after = findTabsByPanel(next, 'b')
    assert.ok(after)
    assert.deepEqual(after.node.panels, ['a', 'b'])
    assert.equal(after.node.active, 1)
    assert.equal(countPanel(next, 'b'), 1)
  })

  it('边缘移动 → 旧位置摘除 + 整树外侧包裹', () => {
    const root = buildThree()
    const next = movePanel(root, 'a', { kind: 'edge', side: 'right' })
    const split = asSplit(next)
    assert.equal(split.dir, 'h')
    assert.deepEqual(asTabs(split.children[1]).panels, ['a'])
    assert.equal(countPanel(next, 'a'), 1)
    assert.ok(findTabsByPanel(split.children[0], 'b'))
  })

  it('空树移动 → 直接成为新树', () => {
    const next = movePanel(null, 'a', { kind: 'edge', side: 'top' })
    assert.deepEqual(asTabs(next).panels, ['a'])
  })
})

/* ---------------- 分隔条 ---------------- */

describe('resizeSashSizes：分隔条尺寸', () => {
  it('正常拖动：按 pxPerWeight 换算，总和不变，其它兄弟不动', () => {
    const out = resizeSashSizes([1, 2, 3], 1, 100, 800 - 8, MIN_PANE_PX)
    const pxPerWeight = (800 - 8) / 6
    assert.ok(Math.abs(out[1] - (2 + 100 / pxPerWeight)) < 1e-9)
    assert.ok(Math.abs(out[2] - (3 - 100 / pxPerWeight)) < 1e-9)
    assert.equal(out[0], 1)
    assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - 6) < 1e-9)
  })

  it('拖过最小尺寸（左）→ 钳制到 120px 等效权重且总和不变', () => {
    // [1,3] @ 800px → pxPerWeight=200，最小权重 = 120/200 = 0.6
    const out = resizeSashSizes([1, 3], 0, -500, 800, MIN_PANE_PX)
    assert.ok(Math.abs(out[0] - 0.6) < 1e-9)
    assert.ok(Math.abs(out[1] - 3.4) < 1e-9)
  })

  it('拖过最小尺寸（右）→ 对称钳制', () => {
    const out = resizeSashSizes([3, 1], 0, 500, 800, MIN_PANE_PX)
    assert.ok(Math.abs(out[0] - 3.4) < 1e-9)
    assert.ok(Math.abs(out[1] - 0.6) < 1e-9)
  })

  it('非法 index / 非法总量 → 原样副本', () => {
    const sizes = [1, 3]
    const outA = resizeSashSizes(sizes, 1, 100, 800)
    assert.deepEqual(outA, sizes)
    assert.notEqual(outA, sizes)
    const outB = resizeSashSizes(sizes, 0, 100, 0)
    assert.deepEqual(outB, sizes)
  })

  it('极小权重（低于最小尺寸）也能恢复到合法区间', () => {
    // 0.1 权重 = 20px < 120px：向左拖 200px 后左格钳到下限、总和不变
    const out = resizeSashSizes([0.1, 3.9], 0, -200, 800, MIN_PANE_PX)
    assert.ok(Math.abs(out[0] - 0.6) < 1e-9)
    assert.ok(Math.abs(out[0] + out[1] - 4) < 1e-9)
  })
})

/* ---------------- 序列化 / 容错 ---------------- */

describe('序列化与非法布局容错', () => {
  const sample: DockNode = {
    kind: 'split',
    dir: 'v',
    sizes: [4, 1],
    children: [
      {
        kind: 'split',
        dir: 'h',
        sizes: [1, 3, 1],
        children: [
          { kind: 'split', dir: 'v', sizes: [1, 1], children: [t('file-system'), t('ui-tree')] },
          t('workspace'),
          { kind: 'split', dir: 'v', sizes: [1, 1], children: [t('inspector'), t('events')] },
        ],
      },
      t('console'),
    ],
  }

  it('serialize → deserialize 往返无损', () => {
    const json = serializeLayout(sample)
    assert.deepEqual(deserializeLayout(json), sample)
  })

  it('null 根与空面板树也可序列化往返', () => {
    assert.equal(deserializeLayout(serializeLayout(null)), null)
  })

  it('非法 JSON / 版本不符 / 非对象 → null', () => {
    assert.equal(deserializeLayout('not-json'), null)
    assert.equal(deserializeLayout('{"version":1,"root":{}}'), null)
    assert.equal(deserializeLayout('42'), null)
  })

  it('normalize：未知面板剔除、去重、active 钳制', () => {
    const out = asTabs(
      normalizeDockNode(
        { kind: 'tabs', id: 'g1', panels: ['a', 'ghost', 'a', 42], active: 9 },
        new Set(['a']),
      ),
    )
    assert.deepEqual(out.panels, ['a'])
    assert.equal(out.id, 'g1')
    assert.equal(out.active, 0)
  })

  it('normalize：单子 split 塌缩、非法 sizes 回退均分', () => {
    const collapsed = normalizeDockNode({
      kind: 'split',
      dir: 'h',
      sizes: [1],
      children: [{ kind: 'tabs', panels: ['a'], active: 0 }],
    })
    assert.equal(collapsed?.kind, 'tabs')

    const fallback = asSplit(
      normalizeDockNode({
        kind: 'split',
        dir: 'v',
        sizes: [1],
        children: [{ kind: 'tabs', panels: ['a'], active: 0 }, { kind: 'tabs', panels: ['b'], active: 0 }],
      }),
    )
    assert.deepEqual(fallback.sizes, [1, 1])
  })

  it('normalize：空 tabs / 坏 dir / 非对象 → null', () => {
    assert.equal(normalizeDockNode({ kind: 'tabs', panels: [], active: 0 }), null)
    assert.equal(normalizeDockNode({ kind: 'split', dir: 'x', children: [] }), null)
    assert.equal(normalizeDockNode('str'), null)
    assert.equal(normalizeDockNode(null), null)
    assert.equal(normalizeDockNode({ kind: 'weird' }), null)
  })
})

/* ---------------- 拖放落点 ---------------- */

describe('computeDropSide：拖放落点判定', () => {
  const rect = { left: 0, top: 0, width: 800, height: 600 } // band = 150

  it('中央区 → center', () => {
    assert.equal(computeDropSide(rect, 400, 300), 'center')
    assert.equal(computeDropSide(rect, 200, 200), 'center')
  })

  it('四边感应带', () => {
    assert.equal(computeDropSide(rect, 100, 300), 'left')
    assert.equal(computeDropSide(rect, 750, 300), 'right')
    assert.equal(computeDropSide(rect, 400, 100), 'top')
    assert.equal(computeDropSide(rect, 400, 560), 'bottom')
  })

  it('角落取深入量更小的方向（先横后纵）', () => {
    assert.equal(computeDropSide(rect, 60, 60), 'left')
    assert.equal(computeDropSide(rect, 760, 20), 'top')
    assert.equal(computeDropSide(rect, 770, 580), 'bottom')
  })

  it('越界指针吸附最近边；小容器使用 32px 下限感应带', () => {
    assert.equal(computeDropSide(rect, 900, 300), 'right')
    const small = { left: 0, top: 0, width: 100, height: 80 }
    assert.equal(computeDropSide(small, 50, 40), 'center') // band=32 时 50,40 仍在中心带
    assert.equal(computeDropSide(small, 10, 40), 'left')
    assert.equal(computeDropSide(small, 50, 5), 'top')
  })
})

/* ---------------- dock store ---------------- */

describe('dock store：布局动作与持久化', () => {
  const before0 = useDockStore.getInitialState()
  afterEach(() => {
    useDockStore.setState(before0)
  })

  it('openPanel(center) → 并入工作区所在组；openPanel(edge) → 外侧包裹', () => {
    useDockStore.getInitialState().initDockLayout(
      { kind: 'tabs', id: 'g-ws', panels: ['workspace'], active: 0 },
      null,
    )
    const s = useDockStore.getState()
    s.openPanel('inspector', 'right')
    let root = useDockStore.getState().root
    let split = asSplit(root)
    assert.equal(split.dir, 'h')
    assert.deepEqual(asTabs(split.children[0]).panels, ['workspace'])
    assert.deepEqual(asTabs(split.children[1]).panels, ['inspector'])
    assert.deepEqual(split.sizes, [3, 1])

    s.openPanel('console', 'center')
    root = useDockStore.getState().root
    const wsGroup = findTabsByPanel(root, 'console')
    assert.ok(wsGroup)
    assert.deepEqual(wsGroup.node.panels, ['workspace', 'console'])
    assert.equal(wsGroup.node.active, 1)
  })

  it('closePanel 剪枝；resetLayout 恢复默认布局', () => {
    const def = t('workspace')
    useDockStore.getInitialState().initDockLayout(def, null)
    const s = useDockStore.getState()
    s.openPanel('console', 'right')
    assert.ok(findTabsByPanel(useDockStore.getState().root, 'console'))
    s.closePanel('console')
    assert.equal(findTabsByPanel(useDockStore.getState().root, 'console'), null)

    s.resetLayout()
    assert.equal(useDockStore.getState().root, def) // 引用相等（纯操作不修改默认布局）
  })

  it('setSizes 按路径替换 split 权重；路径非法时忽略', () => {
    const def: DockNode = {
      kind: 'split',
      dir: 'h',
      sizes: [1, 1],
      children: [t('a'), t('b')],
    }
    useDockStore.getInitialState().initDockLayout(def, null)
    useDockStore.getState().setSizes([], [2, 1])
    assert.deepEqual(asSplit(useDockStore.getState().root).sizes, [2, 1])
    useDockStore.getState().setSizes([5], [9, 9])
    assert.deepEqual(asSplit(useDockStore.getState().root).sizes, [2, 1])
  })

  it('setTabActive / activatePanelIn', () => {
    const def: DockNode = makeTabs(['a', 'b'], 0)
    useDockStore.getInitialState().initDockLayout(def, null)
    const gid = asTabs(useDockStore.getState().root).id
    useDockStore.getState().setTabActive(gid, 1)
    assert.equal(asTabs(useDockStore.getState().root).active, 1)
    useDockStore.getState().setTabActive(gid, 99) // 越界钳制
    assert.equal(asTabs(useDockStore.getState().root).active, 1)
    const next = activatePanelIn(useDockStore.getState().root, 'a')
    assert.equal(asTabs(next).active, 0)
  })
})

describe('布局持久化（localStorage）', () => {
  /** 内存 localStorage 桩（node 环境无 DOM storage） */
  class MemoryStorage {
    private map = new Map<string, string>()
    getItem(key: string): string | null {
      return this.map.has(key) ? (this.map.get(key) as string) : null
    }
    setItem(key: string, value: string): void {
      this.map.set(key, String(value))
    }
    removeItem(key: string): void {
      this.map.delete(key)
    }
    clear(): void {
      this.map.clear()
    }
  }

  before(() => {
    ;(globalThis as Record<string, unknown>).localStorage = new MemoryStorage()
  })

  it('saveLayout → loadPersistedLayout 往返还原', () => {
    const root: DockNode = {
      kind: 'split',
      dir: 'h',
      sizes: [3, 1],
      children: [t('a'), t('b')],
    }
    saveLayout(root)
    const loaded = loadPersistedLayout(new Set(['a', 'b']))
    assert.deepEqual(loaded, root)
  })

  it('损坏数据 / 未知面板 → 容错为 null / 剔除', () => {
    ;(globalThis.localStorage as Storage).setItem(DOCK_LAYOUT_STORAGE_KEY, '{broken')
    assert.equal(loadPersistedLayout(), null)

    saveLayout(t('ghost'))
    assert.equal(loadPersistedLayout(new Set(['a'])), null) // 唯一面板被剔除 → 空布局
    saveLayout(null)
    assert.equal(loadPersistedLayout(), null)
  })

  it('deserializeLayout 直接解析与版本守卫', () => {
    const parsed = deserializeLayout(serializeLayout(t('a')))
    assert.deepEqual(asTabs(parsed).panels, ['a'])
    assert.equal(deserializeLayout('{"version":3,"root":null}'), null)
  })
})

/* ---------------- workspace store ---------------- */

type WorkspaceModule = typeof import('../workspace-store')

describe('workspace store：项目上下文与资产 tabs', () => {
  let ws: WorkspaceModule

  before(async () => {
    // 先注入 location（?project= 初始化），再动态加载模块（保证模块求值时读到 URL）
    ;(globalThis as Record<string, unknown>).location = { search: '?project=D:/demo/MyTool' }
    ws = await import('../workspace-store')
  })

  afterEach(() => {
    ws.useWorkspaceStore.setState(ws.useWorkspaceStore.getInitialState())
  })

  it('从 URL ?project= 初始化项目上下文；v3 不再预置占位 tabs', () => {
    const s = ws.useWorkspaceStore.getState()
    assert.deepEqual(s.currentProject, { name: 'MyTool', path: 'D:/demo/MyTool' })
    assert.deepEqual(s.openTabs, [])
    assert.equal(s.activeTabId, null)
  })

  it('openAsset：重复打开去重并激活；新打开追加并缺省命名', () => {
    const s = ws.useWorkspaceStore.getState()
    s.openAsset({ kind: 'ui', assetPath: 'ui/main.ui.json' })
    let st = ws.useWorkspaceStore.getState()
    assert.equal(st.openTabs.length, 1)
    assert.equal(st.activeTabId, ws.tabIdOf('ui', 'ui/main.ui.json'))

    st.openAsset({ kind: 'script', assetPath: 'logic/parser.ts' }) // 新增
    st = ws.useWorkspaceStore.getState()
    assert.equal(st.openTabs.length, 2)
    assert.equal(st.activeTabId, ws.tabIdOf('script', 'logic/parser.ts'))
    assert.equal(st.openTabs[1].title, 'parser.ts')
  })

  it('closeTab：关闭激活 tab 时右邻优先、末位取左邻', () => {
    const s = ws.useWorkspaceStore.getState()
    s.openAsset({ kind: 'ui', assetPath: 'ui/main.ui.json' })
    s.openAsset({ kind: 'script', assetPath: 'logic/parser.ts' })
    const st = ws.useWorkspaceStore.getState()
    const first = st.openTabs[0].id
    const second = st.openTabs[1].id
    st.closeTab(first)
    assert.equal(ws.useWorkspaceStore.getState().activeTabId, second) // 右邻

    ws.useWorkspaceStore.getState().closeTab(second)
    assert.equal(ws.useWorkspaceStore.getState().activeTabId, null) // 已空
  })

  it('markDirty / clearDirty 脏标记', () => {
    const s = ws.useWorkspaceStore.getState()
    s.openAsset({ kind: 'ui', assetPath: 'ui/main.ui.json' })
    const id = ws.useWorkspaceStore.getState().openTabs[0].id
    ws.useWorkspaceStore.getState().markDirty(id)
    assert.equal(ws.useWorkspaceStore.getState().openTabs[0].dirty, true)
    const before = ws.useWorkspaceStore.getState().saveSeq
    ws.useWorkspaceStore.getState().clearDirty(id)
    assert.equal(ws.useWorkspaceStore.getState().openTabs[0].dirty, false)
    assert.equal(ws.useWorkspaceStore.getState().saveSeq, before + 1, '保存成功序号自增（T8.5 自动重跑）')
  })

  it('closeProject 清空项目与 tabs', () => {
    const s = ws.useWorkspaceStore.getState()
    s.closeProject()
    const st = ws.useWorkspaceStore.getState()
    assert.equal(st.currentProject, null)
    assert.deepEqual(st.openTabs, [])
    assert.equal(st.activeTabId, null)
  })
})

/* ---------------- 查找与路径工具 ---------------- */

describe('查找与路径工具', () => {
  const tree: DockNode = {
    kind: 'split',
    dir: 'h',
    sizes: [1, 1],
    children: [t('a'), { kind: 'split', dir: 'v', sizes: [1, 1], children: [makeTabs(['b', 'x'], 1), t('c')] }],
  }

  it('findTabsByPanel / firstTabsGroup 返回组与路径', () => {
    const ref = findTabsByPanel(tree, 'c')
    assert.ok(ref)
    assert.deepEqual(ref.path, [1, 1])
    assert.ok(firstTabsGroup(tree))
  })

  it('getNodeAtPath / setGroupActive（不可变：原树不变；updateAtPath 经其间接覆盖）', () => {
    assert.deepEqual(asTabs(getNodeAtPath(tree, [1, 1])).panels, ['c'])
    assert.equal(getNodeAtPath(tree, [0, 3]), null)
    assert.equal(asTabs(getNodeAtPath(tree, [1, 0])).active, 1)

    const groupB = asTabs(getNodeAtPath(tree, [1, 0]))
    const next = setGroupActive(tree, groupB.id, 0)
    assert.ok(next)
    assert.equal(asTabs(getNodeAtPath(next, [1, 0])).active, 0)
    assert.equal(asTabs(getNodeAtPath(tree, [1, 0])).active, 1) // 原树未被修改
  })
})
