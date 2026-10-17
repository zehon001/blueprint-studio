/**
 * UI 预制体核心测试（T7.3 · ADR-009）
 *
 * 覆盖（任务卡单测清单）：
 * 1. 路径工具：prefabLabelOf（文件主干）、collectPrefabPaths（嵌套收集 + 去重）；
 * 2. 展开合并语义：props 浅覆盖 / name-transform-id 保留实例 / type-children 以预制体为准 /
 *    events·logicAsset 回落、嵌套实例递归展开；
 * 3. 循环引用检测（中文错误）：自引用 / 互引用链 / 深度上限；findPrefabCycle 与展开同语义；
 * 4. 未加载占位：error + missing 标记 + 中文文案 + 实例 id 保留；
 * 5. 物化（断开预制体）：有效值冻结 + 子树全新 id / 名字去重 / 嵌套实例引用保留 / 纯函数不改性；
 * 6. 导出（保存为预制体）：toPrefabRoot 剥离 events/logicAsset + 深拷贝独立；
 * 7. 缓存：ensurePrefabLoaded 命中/失败/去重、clearPrefabCache 重置、primePrefabCache；
 *    prefetchPrefabs 传递预取（prefab 内嵌 prefab）；
 * 8. store 集成：openUIAsset 预取（打开即缓存全部引用预制体）+ 域资产装载。
 *
 * 运行：npx tsx --test src/ui-editor/prefab.test.ts
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { UIAsset, UINode } from '../ir/types'

import {
  clearPrefabCache,
  collectPrefabPaths,
  ensurePrefabLoaded,
  expandPrefabNode,
  findPrefabCycle,
  getCachedPrefab,
  materializePrefabNode,
  PREFAB_MAX_DEPTH,
  PREFAB_PLACEHOLDER_TYPE,
  prefabLabelOf,
  prefetchPrefabs,
  primePrefabCache,
  setPrefabLoaderContext,
  toPrefabRoot,
} from './prefab'

/* ============================================================
 * 构造辅助
 * ============================================================ */

/** 最小 UINode 构造（缺省给合法 transform/props/children） */
function makeNode(opt: Partial<UINode> & { id: string; name?: string; type?: string }): UINode {
  return {
    id: opt.id,
    name: opt.name ?? opt.id,
    type: opt.type ?? 'panel',
    transform: {
      position: { x: opt.transform?.position.x ?? 0, y: opt.transform?.position.y ?? 0 },
      size: { w: opt.transform?.size.w ?? 100, h: opt.transform?.size.h ?? 40 },
      rotation: opt.transform?.rotation ?? 0,
    },
    theme: opt.theme ?? {},
    props: opt.props ?? {},
    events: opt.events,
    logicAsset: opt.logicAsset,
    prefab: opt.prefab,
    children: opt.children ?? [],
  }
}

function assetOf(root: UINode, name = '预制体'): UIAsset {
  return { version: 2, name, root }
}

/** 简单表解析器：路径 → 资产（Map 即 resolver） */
function resolverOf(map: Map<string, UIAsset>) {
  return (path: string) => map.get(path) ?? null
}

beforeEach(() => {
  // 缓存是模块级状态：每个用例前清空（含失败集合），避免串扰
  clearPrefabCache()
  setPrefabLoaderContext(null)
})

/* ============================================================
 * 1. 路径工具
 * ============================================================ */

describe('prefabLabelOf', () => {
  it('取文件主干（去 .ui.json；容忍反斜杠）', () => {
    assert.equal(prefabLabelOf('ui/prefabs/list-item.ui.json'), 'list-item')
    assert.equal(prefabLabelOf('list-item.ui.json'), 'list-item')
    assert.equal(prefabLabelOf('ui\\prefabs\\a_b.ui.json'), 'a_b')
    assert.equal(prefabLabelOf('ui/prefabs/x.ui.json'), 'x')
  })
})

describe('collectPrefabPaths', () => {
  it('收集树内全部 prefab 路径（嵌套 + 按出现序去重）', () => {
    const root = makeNode({
      id: 'root',
      children: [
        makeNode({ id: 'a', prefab: 'ui/prefabs/a.ui.json' }),
        makeNode({
          id: 'b',
          children: [
            makeNode({ id: 'b1', prefab: 'ui/prefabs/b.ui.json' }),
            makeNode({ id: 'b2', prefab: 'ui/prefabs/a.ui.json' }), // 重复路径
            makeNode({ id: 'b3' }), // 无 prefab
          ],
        }),
      ],
    })
    assert.deepEqual(collectPrefabPaths(root), ['ui/prefabs/a.ui.json', 'ui/prefabs/b.ui.json'])
  })

  it('普通树返回空数组', () => {
    assert.deepEqual(collectPrefabPaths(makeNode({ id: 'root', children: [makeNode({ id: 'x' })] })), [])
  })
})

/* ============================================================
 * 2. 展开合并语义
 * ============================================================ */

describe('expandPrefabNode 合并语义', () => {
  const prefabRoot = makeNode({
    id: 'p_root',
    name: 'prefab-root',
    type: 'vbox',
    transform: { position: { x: 1, y: 2 }, size: { w: 300, h: 200 }, rotation: 0 },
    theme: { tone: 'prefab' },
    props: { spacing: 8, text: 'prefab 文案', keepMe: 'prefab 值' },
    events: ['pressed'],
    logicAsset: 'logic/prefab.bp.json',
    children: [
      makeNode({ id: 'p_lbl', name: 'lbl', type: 'label', props: { text: '来自预制体' } }),
    ],
  })
  const map = new Map<string, UIAsset>([['ui/prefabs/row.ui.json', assetOf(prefabRoot)]])
  const resolve = resolverOf(map)

  it('非 prefab 节点恒等返回（同一引用，零开销）', () => {
    const plain = makeNode({ id: 'plain' })
    const r = expandPrefabNode(plain, resolve)
    assert.equal(r.node, plain)
    assert.equal(r.error, null)
    assert.equal(r.missing, false)
  })

  it('props 浅覆盖；id/name/transform 保留实例；type/children 以预制体为准；实例 children 被忽略', () => {
    const instance = makeNode({
      id: 'inst1',
      name: 'myRow',
      type: 'button', // 实例化时刻的快照类型
      transform: { position: { x: 9, y: 9 }, size: { w: 40, h: 20 }, rotation: 15 },
      props: { text: '实例覆盖' },
      children: [makeNode({ id: 'junk', name: '不应出现' })],
      prefab: 'ui/prefabs/row.ui.json',
    })
    const r = expandPrefabNode(instance, resolve)
    assert.equal(r.error, null)
    assert.equal(r.missing, false)
    const n = r.node
    assert.equal(n.id, 'inst1', 'id 保留实例（DOM reconcile 依赖）')
    assert.equal(n.name, 'myRow', 'name 保留实例（ui 访问器查找键）')
    assert.equal(n.type, 'vbox', 'type 取预制体根')
    assert.deepEqual(n.transform, instance.transform, 'transform 保留实例自身值')
    assert.deepEqual(n.props, { spacing: 8, text: '实例覆盖', keepMe: 'prefab 值' }, '浅覆盖：覆盖键写实例值，其余回落预制体')
    assert.deepEqual(n.theme, { tone: 'prefab' })
    assert.equal(n.children.length, 1, 'children 以预制体为准，实例自身 children 忽略')
    assert.equal(n.children[0]!.id, 'p_lbl')
    assert.equal(n.children[0]!.props.text, '来自预制体')
    assert.equal(n.prefab, 'ui/prefabs/row.ui.json', '展开节点保留溯源字段（data-prefab 用）')
    // 纯函数：不改实例与预制体本体
    assert.equal(instance.children.length, 1)
    assert.equal(prefabRoot.props.text, 'prefab 文案')
  })

  it('events / logicAsset：实例已声明用实例值，空数组回落预制体', () => {
    const base = {
      id: 'inst2',
      prefab: 'ui/prefabs/row.ui.json',
      type: 'vbox',
    }
    const r1 = expandPrefabNode(makeNode({ ...base, events: undefined }), resolve)
    assert.deepEqual(r1.node.events, ['pressed'], '未声明回落预制体根')
    const r2 = expandPrefabNode(makeNode({ ...base, events: [] }), resolve)
    assert.deepEqual(r2.node.events, ['pressed'], '空数组视为未声明')
    const r3 = expandPrefabNode(makeNode({ ...base, events: ['toggled'] }), resolve)
    assert.deepEqual(r3.node.events, ['toggled'], '实例声明优先')
    const r4 = expandPrefabNode(
      makeNode({ ...base, logicAsset: 'logic/inst.bp.json', events: undefined }),
      resolve,
    )
    assert.equal(r4.node.logicAsset, 'logic/inst.bp.json')
  })

  it('嵌套实例递归展开（prefab 内的子节点再引用 prefab）', () => {
    const inner = assetOf(
      makeNode({ id: 'i_root', type: 'label', props: { text: '内层' }, children: [] }),
    )
    const outerRoot = makeNode({
      id: 'o_root',
      type: 'vbox',
      props: {},
      children: [
        makeNode({
          id: 'o_inst',
          name: 'nestedInst',
          type: 'label',
          props: { text: '外层覆盖' },
          prefab: 'ui/prefabs/inner.ui.json',
        }),
      ],
    })
    const m = new Map<string, UIAsset>([
      ['ui/prefabs/inner.ui.json', inner],
      ['ui/prefabs/outer.ui.json', assetOf(outerRoot)],
    ])
    const instance = makeNode({ id: 'top', prefab: 'ui/prefabs/outer.ui.json', type: 'vbox' })
    const r = expandPrefabNode(instance, resolverOf(m))
    assert.equal(r.error, null)
    const nested = r.node.children[0]!
    assert.equal(nested.type, 'label', '嵌套实例以 inner 预制体根 type 为准')
    assert.equal(nested.props.text, '外层覆盖', '嵌套实例 props 同样浅覆盖')
  })
})

/* ============================================================
 * 3. 未加载占位 / 循环引用 / 深度上限
 * ============================================================ */

describe('expandPrefabNode 未加载与受限', () => {
  it('预制体未加载：占位节点 + missing=true + 中文文案（含路径），id 保留', () => {
    const instance = makeNode({ id: 'inst9', name: 'row', prefab: 'ui/prefabs/gone.ui.json' })
    const r = expandPrefabNode(instance, () => null)
    assert.equal(r.missing, true)
    assert.match(r.error ?? '', /未加载/)
    assert.equal(r.node.type, PREFAB_PLACEHOLDER_TYPE)
    assert.equal(r.node.id, 'inst9')
    assert.match(String(r.node.props['__placeholder']), /预制体加载中/)
    assert.match(String(r.node.props['__placeholder']), /ui\/prefabs\/gone\.ui\.json/)
  })

  it('自引用（a → a）报循环引用中文错误', () => {
    const map = new Map<string, UIAsset>([
      ['a.ui.json', assetOf(makeNode({ id: 'ar', type: 'vbox', children: [makeNode({ id: 'x', prefab: 'a.ui.json' })] }))],
    ])
    const r = expandPrefabNode(makeNode({ id: 'i', prefab: 'a.ui.json' }), resolverOf(map))
    assert.equal(r.missing, false)
    assert.match(r.error ?? '', /循环引用/)
    assert.match(r.error ?? '', /a\.ui\.json → a\.ui\.json/)
  })

  it('互引用（a → b → a）报中文错误且链路完整；外层正常部分不受影响', () => {
    const map = new Map<string, UIAsset>([
      [
        'a.ui.json',
        assetOf(
          makeNode({
            id: 'ar',
            type: 'vbox',
            props: { text: 'A 根' },
            children: [makeNode({ id: 'toB', prefab: 'b.ui.json' })],
          }),
        ),
      ],
      [
        'b.ui.json',
        assetOf(
          makeNode({ id: 'br', type: 'vbox', children: [makeNode({ id: 'toA', prefab: 'a.ui.json' })] }),
        ),
      ],
    ])
    const r = expandPrefabNode(makeNode({ id: 'i', prefab: 'a.ui.json' }), resolverOf(map))
    assert.match(r.error ?? '', /检测到预制体循环引用：a\.ui\.json → b\.ui\.json → a\.ui\.json/)
    assert.equal(r.node.type, 'vbox', '外层展开正常')
    assert.equal(r.node.props.text, 'A 根')
    // 出错的内层节点是占位（占位不出现在外层 children 顶层——占位在 b 的子树里）
    const inner = r.node.children[0]!
    assert.equal(inner.type, 'vbox', 'b 层仍正常展开')
    assert.equal(inner.children[0]!.type, PREFAB_PLACEHOLDER_TYPE)
  })

  it(`深度上限（${PREFAB_MAX_DEPTH} 层预制体跳数）报中文错误`, () => {
    // 构造 p0 → p1 → … → p(N) 的长链
    const map = new Map<string, UIAsset>()
    for (let i = 0; i <= PREFAB_MAX_DEPTH + 4; i++) {
      map.set(`p${i}.ui.json`, assetOf(makeNode({ id: `r${i}`, type: 'vbox', children: [makeNode({ id: `c${i}`, prefab: `p${i + 1}.ui.json` })] })))
    }
    const r = expandPrefabNode(makeNode({ id: 'i', prefab: 'p0.ui.json' }), resolverOf(map))
    assert.match(r.error ?? '', /超过最大深度/)
  })

  it('普通深层子树（无 prefab）不触发深度上限', () => {
    // 30 层普通嵌套，最内层才是实例
    let leaf: UINode = makeNode({ id: 'deep-inst', prefab: 'ui/prefabs/row.ui.json' })
    const map = new Map<string, UIAsset>([
      ['ui/prefabs/row.ui.json', assetOf(makeNode({ id: 'pr', type: 'label', props: {} }))],
    ])
    for (let i = 0; i < 30; i++) leaf = makeNode({ id: `w${i}`, children: [leaf] })
    const r = expandPrefabNode(leaf, resolverOf(map))
    assert.equal(r.error, null)
  })
})

describe('findPrefabCycle（装载期全树校验）', () => {
  it('无循环返回 null', () => {
    const map = new Map<string, UIAsset>([
      ['a.ui.json', assetOf(makeNode({ id: 'ar', type: 'vbox', children: [makeNode({ id: 'l', type: 'label' })] }))],
    ])
    const root = makeNode({ id: 'root', children: [makeNode({ id: 'i', prefab: 'a.ui.json' })] })
    assert.equal(findPrefabCycle(root, resolverOf(map)), null)
  })

  it('互引用返回首个循环的中文错误', () => {
    const map = new Map<string, UIAsset>([
      ['a.ui.json', assetOf(makeNode({ id: 'ar', type: 'vbox', children: [makeNode({ id: 'toB', prefab: 'b.ui.json' })] }))],
      ['b.ui.json', assetOf(makeNode({ id: 'br', type: 'vbox', children: [makeNode({ id: 'toA', prefab: 'a.ui.json' })] }))],
    ])
    const root = makeNode({ id: 'root', children: [makeNode({ id: 'i', prefab: 'a.ui.json' })] })
    const msg = findPrefabCycle(root, resolverOf(map))
    assert.match(msg ?? '', /检测到预制体循环引用：a\.ui\.json → b\.ui\.json → a\.ui\.json/)
  })

  it('未加载的预制体不算循环（展开期占位兜底）', () => {
    const root = makeNode({ id: 'root', children: [makeNode({ id: 'i', prefab: 'gone.ui.json' })] })
    assert.equal(findPrefabCycle(root, () => null), null)
  })
})

/* ============================================================
 * 4. 物化 / 导出
 * ============================================================ */

describe('materializePrefabNode（断开预制体）', () => {
  const prefabRoot = makeNode({
    id: 'p_root',
    type: 'vbox',
    theme: { tone: 'prefab' },
    props: { text: 'prefab 文案', gap: 8 },
    events: ['pressed'],
    children: [
      makeNode({ id: 'p_lbl', name: 'lbl', type: 'label', props: { text: 'inner' } }),
      makeNode({ id: 'p_nested', name: 'nested', type: 'button', prefab: 'ui/prefabs/other.ui.json', props: {} }),
    ],
  })
  const instance = makeNode({
    id: 'inst1',
    name: 'item',
    type: 'button',
    transform: { position: { x: 5, y: 6 }, size: { w: 70, h: 30 }, rotation: 0 },
    props: { text: '实例覆盖' },
    children: [makeNode({ id: 'old', name: 'lbl' })], // 将被物化子树替换
    prefab: 'ui/prefabs/row.ui.json',
  })

  it('有效值冻结 + 子树全新 id / 名字去重 / 嵌套实例保留 / 不带 prefab', () => {
    let fresh = 0
    const freshId = (): string => `f${++fresh}`
    const taken = new Set(['item', 'lbl']) // 'lbl' 与预制体子节点撞名
    const m = materializePrefabNode(instance, prefabRoot, taken, freshId)
    assert.equal(m.id, 'inst1', 'id 保留实例')
    assert.equal(m.name, 'item')
    assert.equal(m.type, 'vbox', 'type 取预制体根（以实际渲染结构为准）')
    assert.deepEqual(m.transform, instance.transform, 'transform 保留实例')
    assert.deepEqual(m.props, { text: '实例覆盖', gap: 8 }, 'props 冻结为有效值（预制体 ∪ 实例覆盖）')
    assert.deepEqual(m.theme, { tone: 'prefab' })
    assert.deepEqual(m.events, ['pressed'], '实例未声明事件 → 冻结预制体根默认绑定')
    assert.equal(m.prefab, undefined, '解除引用')
    assert.equal(m.children.length, 2)
    const [lbl, nested] = m.children as [UINode, UINode]
    assert.equal(lbl.id, 'f1', '子树全新 id')
    assert.equal(lbl.name, 'lbl (2)', '与树内已占用名去重')
    assert.equal(lbl.props.text, 'inner', '子树内容来自预制体')
    assert.equal(nested.prefab, 'ui/prefabs/other.ui.json', '嵌套实例保留自身 prefab 引用（独立实例）')
    assert.equal(nested.id, 'f2')
  })

  it('纯函数：不修改实例 / 预制体本体，重放结果幂等', () => {
    const snapshot = JSON.stringify(prefabRoot)
    const before = JSON.stringify(instance)
    let fresh = 0
    const m1 = materializePrefabNode(instance, prefabRoot, new Set(['item']), () => `f${++fresh}`)
    let fresh2 = 0
    const m2 = materializePrefabNode(instance, prefabRoot, new Set(['item']), () => `f${++fresh2}`)
    assert.equal(JSON.stringify(prefabRoot), snapshot, '预制体根未被修改')
    assert.equal(JSON.stringify(instance), before, '实例未被修改')
    assert.deepEqual(
      m1.children.map((c) => `${c.id}:${c.name}`),
      m2.children.map((c) => `${c.id}:${c.name}`),
      '同 id 序列下重放结果一致（命令可重放）',
    )
  })
})

describe('toPrefabRoot（保存为预制体导出）', () => {
  it('深拷贝 + 全层级剥离 events / logicAsset（绑定属实例装配）', () => {
    const src = makeNode({
      id: 'n1',
      name: 'btn',
      type: 'button',
      props: { text: 'OK' },
      events: ['pressed'],
      logicAsset: 'logic/main.bp.json',
      children: [makeNode({ id: 'n2', name: 'inner', type: 'label', events: ['toggled'] })],
    })
    const root = toPrefabRoot(src)
    assert.equal(root.events, undefined)
    assert.equal(root.logicAsset, undefined)
    assert.equal(root.children[0]!.events, undefined)
    assert.equal(root.props.text, 'OK')
    // 深拷贝独立：改导出根不影响源
    root.props.text = 'CHANGED'
    assert.equal(src.props.text, 'OK')
   })
})

/* ============================================================
 * 5. 缓存与预取
 * ============================================================ */

describe('缓存（ensurePrefabLoaded / prime / clear）', () => {
  /** fetch 替身：按 path 查询串返回文件表内容；记录调用 */
  function fetchStub(files: Record<string, string>): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const url = String(input)
      const path = decodeURIComponent(url.split('path=')[1] ?? '')
      calls.push(path)
      const ok = path in files
      const body = ok ? { ok: true, content: files[path]! } : { ok: false, message: '文件不存在' }
      return { json: async () => body } as unknown as Response
    }) as typeof fetch
    return { fetchImpl, calls }
  }

  const content = (root: UINode): string => JSON.stringify(assetOf(root))

  it('命中 → loaded；二次调用 → cached 不再发请求；失败 → error 且失败集合抑制重试', async () => {
    const { fetchImpl, calls } = fetchStub({
      'P/ui/prefabs/a.ui.json': content(makeNode({ id: 'a', type: 'vbox' })),
    })
    setPrefabLoaderContext({ projectPath: 'P', fetchImpl })
    assert.equal(await ensurePrefabLoaded('ui/prefabs/a.ui.json'), 'loaded')
    assert.ok(getCachedPrefab('ui/prefabs/a.ui.json'), '已入缓存')
    assert.equal(getCachedPrefab('ui/prefabs/a.ui.json')!.root.id, 'a')
    assert.equal(await ensurePrefabLoaded('ui/prefabs/a.ui.json'), 'cached')
    assert.equal(calls.length, 1, 'in-flight 去重：只发一次请求')

    assert.equal(await ensurePrefabLoaded('ui/prefabs/missing.ui.json'), 'error')
    const callsAfterFail = calls.length
    assert.equal(await ensurePrefabLoaded('ui/prefabs/missing.ui.json'), 'error')
    assert.equal(calls.length, callsAfterFail, '失败集合抑制渲染路径重试（防占位刷新循环）')
  })

  it('clearPrefabCache 重置（含失败集合）；primePrefabCache 免请求入缓存', async () => {
    const { fetchImpl, calls } = fetchStub({})
    setPrefabLoaderContext({ projectPath: 'P', fetchImpl })
    assert.equal(await ensurePrefabLoaded('ui/prefabs/x.ui.json'), 'error')
    assert.equal(calls.length, 1)
    clearPrefabCache()
    const direct = assetOf(makeNode({ id: 'prime', type: 'vbox' }))
    primePrefabCache('ui/prefabs/y.ui.json', direct)
    assert.equal(await ensurePrefabLoaded('ui/prefabs/y.ui.json'), 'cached')
    assert.equal(calls.length, 1, 'prime 命中不发请求')
    // 失败集合已重置：再次 ensure 会重新发请求（仍失败）
    assert.equal(await ensurePrefabLoaded('ui/prefabs/x.ui.json'), 'error')
    assert.equal(calls.length, 2)
  })

  it('无 loaderContext / 非 JSON / 版本不符 → null（resolve null 不抛错）', async () => {
    setPrefabLoaderContext(null)
    assert.equal(await ensurePrefabLoaded('a.ui.json'), 'error')
    const { fetchImpl } = fetchStub({ 'P/bad.ui.json': '{not json', 'P/ver.ui.json': '{"version":1}' })
    setPrefabLoaderContext({ projectPath: 'P', fetchImpl })
    assert.equal(await ensurePrefabLoaded('bad.ui.json'), 'error')
    assert.equal(await ensurePrefabLoaded('ver.ui.json'), 'error')
  })
})

describe('prefetchPrefabs（BFS 传递预取）', () => {
  it('资产树 + 已取到预制体树内的嵌套路径全部入缓存', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const path = decodeURIComponent(String(input).split('path=')[1] ?? '')
      calls.push(path)
      const files: Record<string, string> = {
        'P/ui/main.ui.json': '',
        'P/ui/prefabs/outer.ui.json': JSON.stringify(
          assetOf(
            makeNode({
              id: 'o',
              type: 'vbox',
              children: [makeNode({ id: 'oi', prefab: 'ui/prefabs/inner.ui.json' })],
            }),
          ),
        ),
        'P/ui/prefabs/inner.ui.json': JSON.stringify(assetOf(makeNode({ id: 'i', type: 'label' }))),
      }
      const ok = path in files
      return { json: async () => (ok ? { ok: true, content: files[path] } : { ok: false }) } as unknown as Response
    }) as typeof fetch
    setPrefabLoaderContext({ projectPath: 'P', fetchImpl })
    const tree = makeNode({
      id: 'root',
      children: [
        makeNode({ id: 'i1', prefab: 'ui/prefabs/outer.ui.json' }),
        makeNode({ id: 'i2', prefab: 'ui/prefabs/outer.ui.json' }), // 重复
      ],
    })
    const paths = await prefetchPrefabs(tree)
    assert.deepEqual(paths.sort(), ['ui/prefabs/inner.ui.json', 'ui/prefabs/outer.ui.json'])
    assert.ok(getCachedPrefab('ui/prefabs/outer.ui.json'))
    assert.ok(getCachedPrefab('ui/prefabs/inner.ui.json'), '嵌套路径经外层预制体树发现并入缓存')
    assert.equal(calls.filter((p) => p === 'P/ui/prefabs/outer.ui.json').length, 1, '同路径只取一次')
  })
})

/* ============================================================
 * 6. store 集成（openUIAsset 预取）
 * ============================================================ */

describe('store.openUIAsset 集成（ADR-009 装载即预取）', () => {
  it('打开资产：预取全部引用预制体 + 域资产装载', async () => {
    const { useUIEditorStore, getSceneTreeDomain } = await import('./store')
    const calls: string[] = []
    const files: Record<string, string> = {
      'P/ui/main.ui.json': JSON.stringify(
        assetOf(
          makeNode({
            id: 'root',
            name: 'root',
            children: [makeNode({ id: 'i1', name: 'row', type: 'vbox', prefab: 'ui/prefabs/row.ui.json' })],
          }),
        ),
      ),
      'P/ui/prefabs/row.ui.json': JSON.stringify(
        assetOf(makeNode({ id: 'pr', name: 'row-root', type: 'vbox', props: { text: 'prefab' } })),
      ),
    }
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const path = decodeURIComponent(String(input).split('path=')[1] ?? '')
      calls.push(path)
      const ok = path in files
      return {
        json: async () => (ok ? { ok: true, content: files[path] } : { ok: false, message: '文件不存在' }),
      } as unknown as Response
    }) as typeof fetch
    // openUIAsset 内部用全局 fetch（prefab 模块未注入时回落）——临时替换全局
    const originalFetch = globalThis.fetch
    ;(globalThis as Record<string, unknown>).fetch = fetchImpl
    try {
      await useUIEditorStore.getState().openUIAsset('P', 'ui/main.ui.json')
      assert.equal(useUIEditorStore.getState().status, 'ready')
      assert.ok(getCachedPrefab('ui/prefabs/row.ui.json'), '打开资产即预取引用预制体')
      assert.equal(getCachedPrefab('ui/prefabs/row.ui.json')!.root.id, 'pr')
      assert.equal(getSceneTreeDomain().asset?.root.id, 'root', '域资产已装载')
      assert.ok(calls.some((p) => p === 'P/ui/prefabs/row.ui.json'))
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      useUIEditorStore.getState().close()
      clearPrefabCache()
      setPrefabLoaderContext(null)
    }
  })
})
