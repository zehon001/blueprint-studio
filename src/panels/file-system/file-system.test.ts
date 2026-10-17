/**
 * 文件系统面板单元测试（T0.7 DoD）
 *
 * 覆盖（任务卡「测试」清单）：
 *  - 路径工具：parent / child / join posix、资产类型判定、新建文件模板内容、名称去重；
 *  - 树纯函数：排序（目录优先 / 名称 collator）、SSE 事件增量合并
 *    （add 已存在幂等、unlink 移除、父目录级联、change 不动结构）；
 *  - 命令日志与 undo 映射：runFsCommand 入栈 / undo 出栈 / redo 回栈、日志上限 100、
 *    rename/create/delete/import 的逆操作与重做操作构造正确；
 *  - api 封装：注入 fetch mock（PUT 请求体、错误映射 FsApiError、projectsRoot 缓存）；
 *  - Menu 组件（happy-dom 渲染）：点击项回调并关闭、disabled 不回调、
 *    点击外部关闭、Esc 关闭、菜单内按下不误关。
 *
 * 运行：npx tsx --test src/panels/file-system/file-system.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  assetKindOf,
  baseName,
  contentForNewFile,
  dedupeName,
  extLabelOf,
  joinPosix,
  newFileTemplateOf,
  parentOf,
  validateFileName,
} from './paths'
import { applyFsEvents, findNode, sortNodes, type FsChangeEvent, type FsNode } from './tree-model'
import { createFsApi, FsApiError, type ImportResult } from './api'
import {
  contentForCreate,
  diffLogTail,
  inverseActionOf,
  pushOp,
  redoActionOf,
  runFsCommand,
  type FsDiskAction,
  type FsDomainState,
  type FsOp,
} from './commands'
import { getDomainState, redo, resetEditorStore, undo } from '@/shell/commands'
import type { MenuItem } from './Menu'

/* ============================================================
 * happy-dom 环境（必须先于 react-dom / Menu 加载）
 * ============================================================ */
import { Window } from 'happy-dom'

const dom = new Window({ url: 'http://localhost/' })

/** 覆盖全局 DOM 绑定（react-dom 需要的部分；个别只读全局跳过） */
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
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key]
  if (value !== undefined) setGlobal(key, value)
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { act } = await import('react')
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Menu } = await import('./Menu')

/* ============================================================
 * 测试工具
 * ============================================================ */

function dirNode(name: string, path: string, children: FsNode[] = []): FsNode {
  return { name, path, type: 'dir', ext: '', children }
}

function fileNode(name: string, path: string): FsNode {
  const dot = name.toLowerCase().lastIndexOf('.')
  return { name, path, type: 'file', ext: dot > 0 ? name.toLowerCase().slice(dot + 1) : '', children: [] }
}

/** 标准样例树：P/ui/main.ui.json · P/logic/main.bp.json · P/assets/a.log */
function sampleTree(): FsNode {
  return dirNode('P', 'P', [
    dirNode('ui', 'P/ui', [fileNode('main.ui.json', 'P/ui/main.ui.json')]),
    dirNode('logic', 'P/logic', [fileNode('main.bp.json', 'P/logic/main.bp.json')]),
    dirNode('assets', 'P/assets', [fileNode('a.log', 'P/assets/a.log')]),
  ])
}

function ev(type: FsChangeEvent['type'], path: string, kind?: 'file' | 'dir'): FsChangeEvent {
  return kind ? { type, path, kind } : { type, path }
}

/* ============================================================
 * 路径工具
 * ============================================================ */

describe('路径工具（posix）', () => {
  it('joinPosix 拼接并忽略空段', () => {
    assert.equal(joinPosix('MyTool', 'ui', 'main.ui.json'), 'MyTool/ui/main.ui.json')
    assert.equal(joinPosix('MyTool', '', 'a.ts'), 'MyTool/a.ts')
    assert.equal(joinPosix('', ''), '')
    assert.equal(joinPosix('MyTool', 'a//b.ts'), 'MyTool/a/b.ts')
  })

  it('parentOf / baseName', () => {
    assert.equal(parentOf('MyTool/ui/x.json'), 'MyTool/ui')
    assert.equal(parentOf('MyTool/ui'), 'MyTool')
    assert.equal(parentOf('MyTool'), '') // '' = 安全根本身
    assert.equal(parentOf(''), '')
    assert.equal(baseName('MyTool/ui/x.json'), 'x.json')
    assert.equal(baseName('MyTool'), 'MyTool')
  })

  it('assetKindOf：.ui.json→ui、.bp.json→blueprint、.ts/.py→script、其余 null', () => {
    assert.equal(assetKindOf('main.ui.json'), 'ui')
    assert.equal(assetKindOf('MAIN.UI.JSON'), 'ui')
    assert.equal(assetKindOf('logic.bp.json'), 'blueprint')
    assert.equal(assetKindOf('a.ts'), 'script')
    assert.equal(assetKindOf('b.py'), 'script')
    assert.equal(assetKindOf('c.json'), null)
    assert.equal(assetKindOf('d.txt'), null)
    assert.equal(assetKindOf('e.ui.json.bak'), null)
  })

  it('extLabelOf 扩展名图标字符', () => {
    assert.equal(extLabelOf('main.ui.json'), 'UI')
    assert.equal(extLabelOf('main.bp.json'), 'BP')
    assert.equal(extLabelOf('a.ts'), 'TS')
    assert.equal(extLabelOf('b.py'), 'PY')
    assert.equal(extLabelOf('c.json'), '{}')
    assert.equal(extLabelOf('shot.png'), 'IMG')
    assert.equal(extLabelOf('noext'), 'F')
  })

  it('dedupeName：同名加 " (n)" 后缀（大小写不敏感，双扩展名后缀在主干上）', () => {
    assert.equal(dedupeName([], 'a.ui.json'), 'a.ui.json')
    assert.equal(dedupeName(['a.ui.json'], 'a.ui.json'), 'a (2).ui.json')
    assert.equal(dedupeName(['a.ui.json', 'a (2).ui.json'], 'a.ui.json'), 'a (3).ui.json')
    // 大小写不敏感判定冲突，输出保留用户输入的大小写
    assert.equal(dedupeName(['a.ui.json'], 'A.UI.JSON'), 'A (2).UI.JSON')
    assert.equal(dedupeName(['新文件夹'], '新文件夹'), '新文件夹 (2)')
  })

  it('validateFileName：空名 / 非法字符 / 保留设备名', () => {
    assert.match(validateFileName('')!, /不能为空/)
    assert.match(validateFileName('a/b')!, /不能包含/)
    assert.match(validateFileName('con.txt')!, /保留设备名/)
    assert.equal(validateFileName('a.ui.json'), null)
    assert.equal(validateFileName('  x.ts '), null)
  })

  it('newFileTemplateOf / contentForNewFile：.ui.json 与 .bp.json 模板、其余空文本', () => {
    assert.equal(newFileTemplateOf('a.ui.json'), 'ui')
    assert.equal(newFileTemplateOf('a.bp.json'), 'bp')
    assert.equal(newFileTemplateOf('a.ts'), 'text')
    const ui = JSON.parse(contentForNewFile('main.ui.json')) as {
      version: number
      name: string
      root: { type: string; children: unknown[] }
    }
    assert.equal(ui.version, 2)
    assert.equal(ui.name, 'main')
    assert.equal(ui.root.type, 'panel') // 单 panel 根节点
    assert.deepEqual(ui.root.children, [])
    const bp = JSON.parse(contentForNewFile('main.bp.json')) as {
      version: number
      entry: string
      graphs: Record<string, { nodes: unknown[]; edges: unknown[] }>
      variables: unknown[]
      events: unknown[]
      snippets: unknown[]
      layout: Record<string, unknown>
    }
    assert.equal(bp.version, 2)
    assert.equal(bp.entry, 'bind')
    assert.deepEqual(Object.keys(bp.graphs), ['bind'])
    assert.deepEqual(bp.graphs.bind, { nodes: [], edges: [] })
    assert.deepEqual(bp.variables, [])
    assert.deepEqual(bp.events, [])
    assert.deepEqual(bp.snippets, [])
    assert.deepEqual(bp.layout, {})
    assert.equal(contentForNewFile('a.txt'), '')
    assert.equal(contentForNewFile('noext'), '')
  })
})

/* ============================================================
 * 树纯函数
 * ============================================================ */

describe('树排序（目录优先 / collator）', () => {
  it('目录排在文件前，各自按名称排序', () => {
    const sorted = sortNodes([
      fileNode('b.txt', 'P/b.txt'),
      dirNode('bDir', 'P/bDir'),
      fileNode('a.txt', 'P/a.txt'),
      dirNode('aDir', 'P/aDir'),
    ])
    assert.deepEqual(
      sorted.map((n) => n.name),
      ['aDir', 'bDir', 'a.txt', 'b.txt'],
    )
  })

  it('collator：数字按值（b2 < b10）、大小写不敏感', () => {
    const files = [fileNode('B10.txt', 'p'), fileNode('b2.txt', 'p'), fileNode('A.txt', 'p')]
    const sorted = sortNodes(files).map((n) => n.name)
    assert.deepEqual(sorted, ['A.txt', 'b2.txt', 'B10.txt'])
  })
})

describe('SSE 事件增量合并（applyFsEvents）', () => {
  it('add：文件落入已有目录并保持排序', () => {
    const tree = applyFsEvents(sampleTree(), [ev('add', 'ui/aaa.ui.json', 'file')])!
    const ui = findNode(tree, 'P/ui')!
    assert.deepEqual(
      ui.children.map((c) => c.name),
      ['aaa.ui.json', 'main.ui.json'],
    )
    const added = findNode(tree, 'P/ui/aaa.ui.json')!
    assert.equal(added.type, 'file')
    assert.equal(added.ext, 'json')
  })

  it('add：已存在幂等（不产生重复节点）', () => {
    const tree = applyFsEvents(sampleTree(), [
      ev('add', 'ui/main.ui.json', 'file'),
      ev('add', 'ui/main.ui.json', 'file'),
    ])!
    const ui = findNode(tree, 'P/ui')!
    assert.equal(ui.children.filter((c) => c.name === 'main.ui.json').length, 1)
    assert.equal(ui.children.length, 1)
  })

  it('add：父目录级联补齐（深层路径一次建全）', () => {
    const tree = applyFsEvents(sampleTree(), [ev('add', 'logic/sub/deep/x.ts', 'file')])!
    const sub = findNode(tree, 'P/logic/sub')!
    assert.equal(sub.type, 'dir')
    const deep = findNode(tree, 'P/logic/sub/deep')!
    assert.equal(deep.type, 'dir')
    assert.equal(findNode(tree, 'P/logic/sub/deep/x.ts')!.type, 'file')
  })

  it('add：kind=dir 建目录节点', () => {
    const tree = applyFsEvents(sampleTree(), [ev('add', 'plugins', 'dir')])!
    const plugins = findNode(tree, 'P/plugins')!
    assert.equal(plugins.type, 'dir')
    assert.deepEqual(plugins.children, [])
  })

  it('unlink：移除文件；目标不存在时忽略', () => {
    const tree = applyFsEvents(sampleTree(), [ev('unlink', 'assets/a.log'), ev('unlink', 'assets/ghost.log')])!
    assert.equal(findNode(tree, 'P/assets/a.log'), null)
    assert.equal(findNode(tree, 'P/assets')!.children.length, 0)
  })

  it('unlink：移除目录（子树随之消失）；子项先删再删目录也幂等', () => {
    const tree = applyFsEvents(sampleTree(), [
      ev('unlink', 'logic/main.bp.json'),
      ev('unlink', 'logic'),
    ])!
    assert.equal(findNode(tree, 'P/logic'), null)
    assert.equal(findNode(tree, 'P/ui')!.name, 'ui')
  })

  it('change：不改变结构（返回原引用，调用方据此跳过刷新）', () => {
    const tree = sampleTree()
    assert.equal(applyFsEvents(tree, [ev('change', 'ui/main.ui.json')]), tree)
  })

  it('批合并：多条 add/unlink 按序生效', () => {
    const tree = applyFsEvents(sampleTree(), [
      ev('add', 'assets/readme.md', 'file'),
      ev('add', 'assets/img', 'dir'),
      ev('add', 'assets/img/logo.png', 'file'),
      ev('unlink', 'assets/a.log'),
    ])!
    const assets = findNode(tree, 'P/assets')!
    assert.deepEqual(
      assets.children.map((c) => `${c.name}${c.type === 'dir' ? '/' : ''}`),
      ['img/', 'readme.md'],
    )
    assert.equal(findNode(tree, 'P/assets/img/logo.png')!.type, 'file')
  })

  it('监视根级事件（path 为空）→ 返回 undefined 要求整体重载', () => {
    const tree = sampleTree()
    assert.equal(applyFsEvents(tree, [ev('unlink', '')]), undefined)
    assert.equal(applyFsEvents(tree, [ev('add', 'ui/x.json')]), undefined) // 缺 kind → 不可安全合并
  })
})

/* ============================================================
 * filesystem 命令域：日志与 undo/redo 映射
 * ============================================================ */

describe('filesystem 命令日志与 undo 映射（T0.7 DoD）', () => {
  beforeEach(() => {
    resetEditorStore()
  })

  it('runFsCommand 入域日志；undo 移出；redo 加回（结构操作可撤销）', () => {
    const r = runFsCommand('新建文件「a.ui.json」', {
      kind: 'create',
      path: 'P/ui/a.ui.json',
      targetKind: 'file',
      template: 'ui',
    })
    assert.equal(r.changed, true)
    assert.equal(r.domain, 'filesystem')
    assert.deepEqual(
      getDomainState<FsDomainState>('filesystem').ops.map((o) => o.kind),
      ['create'],
    )
    const notice = undo()
    assert.equal(notice?.domains.includes('filesystem'), true)
    assert.equal(getDomainState<FsDomainState>('filesystem').ops.length, 0)
    redo()
    const ops = getDomainState<FsDomainState>('filesystem').ops
    assert.equal(ops.length, 1)
    assert.equal(ops[0].kind, 'create')
    assert.equal(ops[0].path, 'P/ui/a.ui.json')
    assert.equal(ops[0].label, '新建文件「a.ui.json」')
    assert.equal(typeof ops[0].ts, 'string')
  })

  it('pushOp 日志上限 100（超出丢最旧）', () => {
    const st: FsDomainState = { ops: [] }
    for (let i = 0; i < 120; i++) {
      pushOp(st, { kind: 'delete', label: `删除${i}`, ts: `t${i}`, path: `p${i}` })
    }
    assert.equal(st.ops.length, 100)
    assert.equal(st.ops[0].path, 'p20')
    assert.equal(st.ops[99].path, 'p119')
  })

  it('inverseActionOf：rename→move 回去、create/import→delete、delete→unavailable（T7.4 提示）', () => {
    const rename = inverseActionOf({ kind: 'rename', label: '', ts: '', from: 'P/a.ts', to: 'P/b.ts' })
    assert.deepEqual(rename, { action: 'move', from: 'P/b.ts', to: 'P/a.ts' })
    const create = inverseActionOf({ kind: 'create', label: '', ts: '', path: 'P/ui/a.ui.json' })
    assert.deepEqual(create, { action: 'delete', path: 'P/ui/a.ui.json' })
    const imp = inverseActionOf({ kind: 'import', label: '', ts: '', path: 'P/assets/x.log', sourcePath: 'D:/s.log' })
    assert.deepEqual(imp, { action: 'delete', path: 'P/assets/x.log' })
    const del: FsDiskAction = inverseActionOf({ kind: 'delete', label: '', ts: '', path: 'P/a.ts', wasKind: 'file' })
    assert.equal(del.action, 'unavailable')
    if (del.action === 'unavailable') assert.match(del.message, /T7\.4/)
  })

  it('redoActionOf：rename 前移、create 按模板/内容重建、import 再导入、delete 再删', () => {
    const rename = redoActionOf({ kind: 'rename', label: '', ts: '', from: 'P/a.ts', to: 'P/b.ts' })
    assert.deepEqual(rename, { action: 'move', from: 'P/a.ts', to: 'P/b.ts' })

    const ui = redoActionOf({
      kind: 'create',
      label: '',
      ts: '',
      path: 'P/ui/main.ui.json',
      targetKind: 'file',
      template: 'ui',
    })
    assert.ok(ui.action === 'write')
    if (ui.action === 'write') {
      const asset = JSON.parse(ui.content) as { version: number; root: { type: string } }
      assert.equal(asset.version, 2)
      assert.equal(asset.root.type, 'panel')
    }

    const bp = contentForCreate({ kind: 'create', label: '', ts: '', path: 'P/logic/a.bp.json', targetKind: 'file', template: 'bp' })
    const bpAsset = JSON.parse(bp) as { entry: string; graphs: Record<string, unknown> }
    assert.equal(bpAsset.entry, 'bind')
    assert.deepEqual(Object.keys(bpAsset.graphs), ['bind'])

    const text = redoActionOf({
      kind: 'create',
      label: '',
      ts: '',
      path: 'P/a.txt',
      targetKind: 'file',
      template: 'text',
      content: 'hello',
    })
    assert.ok(text.action === 'write' && text.content === 'hello')

    const dir = redoActionOf({ kind: 'create', label: '', ts: '', path: 'P/data', targetKind: 'dir' })
    assert.deepEqual(dir, { action: 'mkdir', path: 'P/data' })

    const imp = redoActionOf({ kind: 'import', label: '', ts: '', path: 'P/assets/x.log', sourcePath: 'D:/s.log' })
    assert.deepEqual(imp, { action: 'import', targetDir: 'P/assets', sourcePath: 'D:/s.log' })

    const del = redoActionOf({ kind: 'delete', label: '', ts: '', path: 'P/a.ts' })
    assert.deepEqual(del, { action: 'delete', path: 'P/a.ts' })
  })

  it('diffLogTail：undo 定位移出条目、redo 定位加回条目、结构异常返回双 null', () => {
    const a: FsOp = { kind: 'create', label: 'c1', ts: 't1', path: 'P/a' }
    const b: FsOp = { kind: 'rename', label: 'r1', ts: 't2', from: 'P/a', to: 'P/b' }
    const c: FsOp = { kind: 'delete', label: 'd1', ts: 't3', path: 'P/c' }
    assert.deepEqual(diffLogTail([a, b, c], [a, b]), { removed: c, added: null })
    assert.deepEqual(diffLogTail([a], [a, b]), { removed: null, added: b })
    assert.deepEqual(diffLogTail([a, b], [a, b]), { removed: null, added: null })
    // 中间内容对不上（域重挂载等）：不做磁盘补偿
    assert.deepEqual(diffLogTail([a, b], [a, c]), { removed: null, added: null })
    assert.deepEqual(diffLogTail([], [a, b]), { removed: null, added: null })
  })
})

/* ============================================================
 * api 封装（注入 fetch mock）
 * ============================================================ */

describe('api 封装（注入式 fetch）', () => {
  interface CapturedCall {
    url: string
    method?: string
    body?: unknown
  }

  function okResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
  }

  it('writeFile：PUT /api/file 且请求体含 path/content', async () => {
    const calls: CapturedCall[] = []
    const api = createFsApi(async (url, init) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) })
      return okResponse({ path: 'P/ui/a.json', size: 2 })
    })
    const r = await api.writeFile('P/ui/a.json', '{}')
    assert.equal(r.size, 2)
    assert.equal(calls[0].url, '/api/file')
    assert.equal(calls[0].method, 'PUT')
    assert.deepEqual(calls[0].body, { path: 'P/ui/a.json', content: '{}' })
  })

  it('move / import / delete 的端点与方法', async () => {
    const calls: CapturedCall[] = []
    const api = createFsApi(async (url, init) => {
      calls.push({ url, method: init?.method })
      const payload = url.startsWith('/api/import')
        ? { ok: true, target: 'P/assets/x.log', files: 1, bytes: 3, renamed: false }
        : { path: 'x', moved: true, kind: 'file' }
      return okResponse(payload)
    })
    const imp: ImportResult = await api.importFile('P/assets', 'D:/s.log')
    assert.equal(imp.target, 'P/assets/x.log')
    const moved = await api.move('P/a.ts', 'P/b.ts')
    assert.equal(moved.moved, true)
    await api.deletePath('P/b.ts')
    assert.equal(calls[0].url, '/api/import')
    assert.equal(calls[1].url, '/api/move')
    assert.equal(calls[2].url, '/api/file?path=P%2Fb.ts')
    assert.equal(calls[2].method, 'DELETE')
  })

  it('readTree 解析 tree 字段', async () => {
    const api = createFsApi(async () => okResponse({ ok: true, tree: sampleTree() }))
    const { tree } = await api.readTree('P')
    assert.equal(tree.name, 'P')
    assert.equal(tree.children.length, 3)
  })

  it('错误映射：ok:false / 非 2xx → FsApiError(status, message)', async () => {
    const api = createFsApi(async () => okResponse({ ok: false, message: '路径越权：不允许上跳' }, 403))
    await assert.rejects(() => api.writeFile('../x', ''), (e: unknown) => {
      assert.ok(e instanceof FsApiError)
      assert.equal((e as FsApiError).status, 403)
      assert.equal((e as FsApiError).message, '路径越权：不允许上跳')
      return true
    })
  })

  it('网络失败 → FsApiError(0)', async () => {
    const api = createFsApi(async () => {
      throw new Error('ECONNREFUSED')
    })
    await assert.rejects(() => api.readTree('P'), (e: unknown) => {
      assert.ok(e instanceof FsApiError)
      assert.equal((e as FsApiError).status, 0)
      return true
    })
  })

  it('projectsRoot：GET /api/projects 且结果缓存', async () => {
    let calls = 0
    const api = createFsApi(async () => {
      calls++
      return okResponse({ ok: true, root: 'D:/repo/_projects', projects: [] })
    })
    assert.equal(await api.projectsRoot(), 'D:/repo/_projects')
    assert.equal(await api.projectsRoot(), 'D:/repo/_projects')
    assert.equal(calls, 1)
  })

  it('watchUrl：/api/watch 且 path 编码', () => {
    const api = createFsApi(async () => okResponse({}))
    assert.equal(api.watchUrl('My Tool'), '/api/watch?path=My%20Tool')
  })
})

/* ============================================================
 * Menu 组件（happy-dom 渲染）
 * ============================================================ */

describe('Menu 组件（通用右键菜单）', () => {
  /** 挂载一个受控 Menu；返回收集器与卸载函数 */
  async function mountMenu(items: readonly MenuItem[]): Promise<{
    calls: string[]
    isClosed: () => boolean
    unmount: () => Promise<void>
  }> {
    const calls: string[] = []
    let closed = false
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    // happy-dom 的 HTMLDivElement 与 DOM lib 类型不兼容，双跳桥接（运行时同一对象）
    const root = createRoot(container as unknown as HTMLElement)
    const wrapped: MenuItem[] = items.map((it) =>
      it.separator || !it.label ? it : { ...it, onSelect: () => calls.push(it.label ?? '') },
    )
    await act(async () => {
      root.render(createElement(Menu, { x: 10, y: 10, items: wrapped, onClose: () => { closed = true } }))
    })
    return {
      calls,
      isClosed: () => closed,
      unmount: () =>
        act(async () => {
          root.unmount()
          container.remove()
        }),
    }
  }

  const sampleItems = [
    { label: '打开' },
    { label: '重命名' },
    { separator: true },
    { label: '删除', danger: true },
    { label: '不可用', disabled: true },
  ]

  afterEach(async () => {
    dom.document.body.innerHTML = ''
  })

  it('渲染：菜单项与分隔线出现（portal 到 body）', async () => {
    const h = await mountMenu(sampleItems)
    const menuEl = dom.document.querySelector('.fs-menu')
    assert.ok(menuEl, '菜单应渲染到 document.body')
    assert.equal(dom.document.querySelectorAll('.fs-menu-item').length, 4)
    assert.equal(dom.document.querySelectorAll('.fs-menu-sep').length, 1)
    const danger = dom.document.querySelector('.fs-menu-item.danger') as unknown as HTMLButtonElement
    assert.equal(danger.textContent?.includes('删除'), true)
    const disabled = dom.document.querySelector('.fs-menu-item:disabled')
    assert.ok(disabled)
    await h.unmount()
  })

  it('点击菜单项：回调执行并关闭', async () => {
    const h = await mountMenu(sampleItems)
    const btns = dom.document.querySelectorAll('.fs-menu-item')
    const renameBtn = btns[1] as unknown as HTMLButtonElement
    await act(async () => {
      renameBtn.dispatchEvent(
        new dom.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
      )
    })
    assert.deepEqual(h.calls, ['重命名'])
    assert.equal(h.isClosed(), true)
    await h.unmount()
  })

  it('disabled 项点击不回调也不关闭', async () => {
    const h = await mountMenu(sampleItems)
    const disabledBtn = dom.document.querySelectorAll('.fs-menu-item')[3] as unknown as HTMLButtonElement
    assert.equal(disabledBtn.disabled, true)
    await act(async () => {
      disabledBtn.dispatchEvent(
        new dom.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
      )
    })
    assert.deepEqual(h.calls, [])
    assert.equal(h.isClosed(), false)
    await h.unmount()
  })

  it('点击菜单外（pointerdown）关闭；菜单内按下不误关', async () => {
    const h = await mountMenu(sampleItems)
    const menuEl = dom.document.querySelector('.fs-menu') as unknown as HTMLElement
    await act(async () => {
      menuEl.dispatchEvent(
        new dom.MouseEvent('pointerdown', { bubbles: true, cancelable: true }) as unknown as Event,
      )
    })
    assert.equal(h.isClosed(), false, '菜单内 pointerdown 不应关闭')
    await act(async () => {
      dom.document.body.dispatchEvent(new dom.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    assert.equal(h.isClosed(), true, '菜单外 pointerdown 应关闭')
    await h.unmount()
  })

  it('Esc 键关闭', async () => {
    const h = await mountMenu(sampleItems)
    await act(async () => {
      dom.document.body.dispatchEvent(
        new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    assert.equal(h.isClosed(), true)
    await h.unmount()
  })

  it('空 items 渲染空菜单不炸', async () => {
    const h = await mountMenu([])
    assert.equal(dom.document.querySelector('.fs-menu') !== null, true)
    assert.equal(dom.document.querySelectorAll('.fs-menu-item').length, 0)
    await h.unmount()
  })
})
