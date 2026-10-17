/**
 * 脚本资产运行链测试（T3.3 · 任务卡单测清单 2 / 3）
 *
 * .ts 从绑定到运行的完整路径（mock fetch，转译走真 esbuild——server/transpile.ts）：
 *   绑定发现（.ts logicAsset）→ GET /api/file 取源码 → POST /api/transpile（服务端转译，
 *   语法级错误 / 警告）→ parseScriptToIR(源码) 得同一 IRAsset（D3 单一 IR 路径）
 *   → createRuntime（specs/ui/hub 全复用）→ start() 触发 @on('start') 链。
 *
 * 用例：
 * 1. .ts 绑定加载 → 解释器启动 → @on('start') 链执行（print + ui.title.text 改 DOM）；
 *    UI 按钮 pressed 事件 → @on('btnGo','pressed') 链（与蓝图 T2.6 同款断言，等价性）
 * 2. 解析错误资产（无逻辑类）→ print 错误 + onError + 不崩，其它绑定照常
 * 3. 转译语法错误（服务端 esbuild 报行列）→ print 错误 + onError + 不崩
 * 4. 转译警告 → print 提示但继续；转译服务响应异常 → 按加载失败处理不崩
 * 5. .py 绑定 → 打印「T4.1 接入」提示，不 fetch 不报错不崩
 * 6. 混合绑定：同一 UI 一个 .bp.json 节点 + 一个 .ts 节点 → 两个 runtime 都启动（D3 等价性）
 *
 * 运行：npx tsx --test src/runtime/binding-script.test.ts
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
const { BindingRunner } = await import('./binding')
const { renderUI } = await import('./render/render')
const { transpileTypeScript } = await import('../../server/transpile')

/* ── 公共工具 ─────────────────────────────────────────────── */

/** 构造 UINode（同 binding.test.ts） */
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

/** fetch 调用记录（断言「.py 不发起请求」等） */
interface FetchCall {
  method: string
  url: string
  body?: unknown
}

/** mock fetch：GET /api/file 按路径路由；POST /api/transpile 缺省走真 esbuild 转译 */
function mockScriptFetch(
  opts: {
    /** 完整 path（含项目前缀）→ 文件内容 */
    files?: Record<string, string>;
    /** 转译替身（缺省调 server/transpileTypeScript 真转换）；返回响应体 */
    transpile?: (content: string, path: string) => unknown;
  },
  calls: FetchCall[] = [],
): typeof fetch {
  const respond = (body: unknown, ok = true): Response =>
    ({ ok, status: 200, json: async () => body }) as unknown as Response
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body != null ? JSON.parse(String(init.body)) : undefined })
    if (method === 'GET' && url.startsWith('/api/file?')) {
      const path = new URL(url, 'http://localhost').searchParams.get('path') ?? ''
      const content = opts.files?.[path]
      return content === undefined
        ? respond({ ok: false, message: `文件不存在：${path}` }, false)
        : respond({ ok: true, content })
    }
    if (method === 'POST' && url === '/api/transpile') {
      const body = (init?.body ? JSON.parse(String(init.body)) : {}) as { path?: string; content?: string }
      if (opts.transpile) return respond(opts.transpile(body.content ?? '', body.path ?? ''))
      const r = await transpileTypeScript(body.content ?? '', { path: body.path })
      return respond(
        r.ok
          ? { ok: true, js: r.js, warnings: r.warnings }
          : { ok: false, message: r.message, errors: r.errors },
      )
    }
    return respond({ ok: false, message: `未知 API：${method} ${url}` }, false)
  }) as unknown as typeof fetch
}

/** 轮询等待条件成立（解释器事件队列 / 异步链提交均为异步） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 渲染 UI 资产并挂载到 body（用例结束自行 destroy） */
function renderToBody(asset: UIAsset): UIRenderHandle {
  const handle = renderUI(asset, { mode: 'runtime', onEvent: () => {} })
  ;(doc as unknown as Document).body.appendChild(handle.el)
  return handle
}

/** 按 data-uid 取节点元素 */
function elOf(handle: UIRenderHandle, uid: string): HTMLElement | null {
  return handle.el.querySelector<HTMLElement>(`[data-uid="${uid}"]`)
}

/* ── 样本 ─────────────────────────────────────────────────── */

/** 受控子集脚本：start 链（print + 读暴露变量写 ui）+ 按钮 pressed 链 */
const HERO_TS = `@tool('英雄逻辑')
class HeroLogic {
  @expose({ type: 'string', default: '初始标题' })
  titleText: string

  @on('start')
  onStart(): void {
    print('脚本已启动')
    ui.title.text = this.titleText
  }

  @on('btnGo', 'pressed')
  onTap(): void {
    ui.title.text = '已点击'
  }
}
`

/** 蓝图 IR：start 链 system.print（混合绑定用） */
function blueprintIR(name: string, printText: string): IRAsset {
  return {
    version: 2,
    name,
    entry: 'bind',
    graphs: {
      bind: {
        nodes: [
          { id: 'e', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'p', type: 'system.print', params: {}, pinDefaults: { value: printText }, position: { x: 100, y: 0 } },
        ],
        edges: [{ id: 'ed1', kind: 'exec', from: { node: 'e', pin: 'exec' }, to: { node: 'p', pin: 'exec' } }],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

/* ══ 1. .ts 绑定 → 同一 IR 路径执行（D3 等价性）════════════ */

describe('脚本资产运行链（.ts → 服务端转译 → parseScriptToIR → createRuntime）', () => {
  test('start 链执行（print + ui 写 DOM）；pressed 事件路由到 @on 方法链', async () => {
    const btn = mkNode('btn', 'btnGo', 'button', { text: '点我' })
    const title = mkNode('ttl', 'title', 'label', { text: '占位' })
    const asset = mkAsset(mkNode('root', 'root', 'vbox', { logicAsset: 'logic/hero.ts' }, [btn, title]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const calls: FetchCall[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch(
        { files: { '演示项目/logic/hero.ts': HERO_TS } },
        calls,
      ),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    // 完整链路请求序：先 GET /api/file 取源码，再 POST /api/transpile 转译
    assert.deepEqual(
      calls.map((c) => `${c.method} ${new URL(c.url, 'http://localhost').pathname}`),
      ['GET /api/file', 'POST /api/transpile'],
      '运行窗口走服务端转译（PLAN §9.2）',
    )
    const trBody = calls[1]!.body as { path: string; content: string }
    assert.equal(trBody.path, 'logic/hero.ts')
    assert.equal(trBody.content, HERO_TS, '转译请求携带源码原文')

    // 转译 + 解析成功 → createRuntime 启动 → @on('start') 链执行
    await waitFor(() => lines.some((l) => l.includes('[绑定] 已加载 logic/hero.ts')), '绑定加载行')
    assert.ok(lines.some((l) => l.includes('「英雄逻辑」')), '资产名来自 @tool 注解')
    await waitFor(() => lines.some((l) => l.includes('[脚本:英雄逻辑] 脚本已启动')), 'start 链 print（脚本前缀）')
    await waitFor(() => elOf(handle, 'ttl')!.textContent === '初始标题', 'ui.title.text 经 UiHandle 直改 DOM（值来自 @expose 默认）')

    // UI 内建事件 → 事件总线 → @on('btnGo','pressed') 方法链（与蓝图 T2.6 同语义）
    runner.routeEvent({ nodeName: 'btnGo', nodeType: 'button', event: 'pressed' })
    await waitFor(() => elOf(handle, 'ttl')!.textContent === '已点击', 'pressed 链 ui 写入')
    assert.ok(errors.length === 0, `无错误（实际：${errors.join('|')}）`)

    runner.stop()
    handle.destroy()
  })

  test('转译警告：print 提示但继续加载执行', async () => {
    const asset = mkAsset(mkNode('root', 'root', 'vbox', { logicAsset: 'logic/hero.ts' }, []))
    const handle = renderToBody(asset)
    const lines: string[] = []
    const errors: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch(
        {
          files: { '演示项目/logic/hero.ts': HERO_TS },
          transpile: (content) => ({
            ok: true,
            js: content,
            warnings: [{ line: 2, column: 3, message: '测试警告：演示用' }],
          }),
        },
      ),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(() => lines.some((l) => l.includes('[转译] logic/hero.ts 警告（第 2 行第 3 列）：测试警告')), '警告行带行列')
    await waitFor(() => lines.some((l) => l.includes('[绑定] 已加载 logic/hero.ts')), '警告不阻断加载')
    await waitFor(() => lines.some((l) => l.includes('脚本已启动')), '照常执行 start 链')
    assert.ok(errors.length === 0)
    runner.stop()
    handle.destroy()
  })

  test('转译服务响应异常（无 ok 字段）→ 按加载失败处理，不崩', async () => {
    const asset = mkAsset(mkNode('root', 'root', 'vbox', { logicAsset: 'logic/hero.ts' }, []))
    const handle = renderToBody(asset)
    const lines: string[] = []
    const errors: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch({
        files: { '演示项目/logic/hero.ts': HERO_TS },
        transpile: () => ({ detail: '不是转译响应' }), // 缺 ok 字段 → 响应形状异常
      }),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(() => lines.some((l) => l.includes('加载失败：logic/hero.ts')), '失败行')
    assert.ok(lines.some((l) => l.includes('转译服务响应异常')), '响应异常有中文说明')
    assert.ok(errors.some((m) => m.includes('logic/hero.ts')), 'onError 上报')
    runner.stop()
    handle.destroy()
  })
})

/* ══ 2. 错误资产：跳过不崩，其它绑定照常 ═══════════════════ */

describe('脚本资产错误处理（解析错误 / 转译语法错误）', () => {
  test('解析错误（无逻辑类）：error 诊断 → print + onError + 跳过；同 UI 好 .ts 照常', async () => {
    const bad = mkNode('a', 'a1', 'label')
    bad.logicAsset = 'logic/bad.ts'
    const good = mkNode('b', 'b1', 'label')
    good.logicAsset = 'logic/good.ts'
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [bad, good]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch({
        files: {
          '演示项目/logic/bad.ts': 'const broken = 1\n', // 无逻辑类 → 解析 error 诊断
          '演示项目/logic/good.ts': HERO_TS,
        },
      }),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(() => lines.some((l) => l.includes('加载失败：logic/bad.ts')), '坏资产失败行')
    assert.ok(lines.some((l) => l.includes('脚本解析错误')), '错误行来自解析诊断（error 级）')
    await waitFor(() => lines.some((l) => l.includes('已加载 logic/good.ts')), '好资产照常加载')
    await waitFor(() => lines.some((l) => l.includes('脚本已启动')), '好资产照常执行')
    assert.ok(errors.some((m) => m.includes('logic/bad.ts')), 'onError 上报坏资产')
    runner.stop()
    handle.destroy()
  })

  test('转译语法错误：服务端 esbuild 行列诊断 → print + onError + 不崩；蓝图绑定不受影响', async () => {
    const bad = mkNode('a', 'a1', 'label')
    bad.logicAsset = 'logic/syntax-broken.ts'
    const good = mkNode('b', 'b1', 'label')
    good.logicAsset = 'logic/main.bp.json'
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [bad, good]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch({
        files: {
          '演示项目/logic/syntax-broken.ts': 'const ok = 1\nconst bad = ;\n',
          '演示项目/logic/main.bp.json': JSON.stringify(blueprintIR('按钮逻辑', '蓝图已启动')),
        },
      }),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(() => lines.some((l) => l.includes('加载失败：logic/syntax-broken.ts')), '坏资产失败行')
    assert.ok(lines.some((l) => l.includes('TS 转译失败') && /第 \d+ 行第 \d+ 列/.test(l)), '错误行带服务端行列诊断')
    await waitFor(() => lines.some((l) => l.includes('已加载 logic/main.bp.json')), '蓝图绑定不受影响')
    await waitFor(() => lines.some((l) => l.includes('蓝图已启动')), '蓝图照常执行')
    assert.ok(errors.some((m) => m.includes('logic/syntax-broken.ts')), 'onError 上报')
    runner.stop()
    handle.destroy()
  })

  test('.py 绑定：打印 T4.1 提示，不 fetch、不转译、不报错、不崩', async () => {
    const py = mkNode('p', 'py1', 'label')
    py.logicAsset = 'logic/hero.py'
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [py]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const calls: FetchCall[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch({}, calls),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(() => lines.some((l) => l.includes('logic/hero.py') && l.includes('T4.1')), '提示行含 T4.1')
    assert.ok(lines.some((l) => l.includes('Python 运行时')), '提示行说明 Python 运行时未接入')
    assert.deepEqual(calls, [], '不发起任何请求（取文件 / 转译都没有）')
    assert.ok(errors.length === 0, '提示不是错误（onError 不触发）')
    runner.stop()
    handle.destroy()
  })
})

/* ══ 3. 混合绑定：.bp.json + .ts 同 UI 双 runtime（D3 等价性）══ */

describe('混合绑定（同一 UI 一个蓝图节点 + 一个脚本节点）', () => {
  test('两个 runtime 都启动：蓝图与脚本同一条 IR 路径各自执行 start 链', async () => {
    const bpNode = mkNode('a', 'bp1', 'label')
    bpNode.logicAsset = 'logic/main.bp.json'
    const tsNode = mkNode('b', 'ts1', 'label')
    tsNode.logicAsset = 'logic/hero.ts'
    const asset = mkAsset(mkNode('root', 'root', 'vbox', {}, [bpNode, tsNode]))
    const handle = renderToBody(asset)

    const lines: string[] = []
    const errors: string[] = []
    const runner = new BindingRunner({
      project: '演示项目',
      asset,
      renderHandle: handle,
      fetchImpl: mockScriptFetch({
        files: {
          '演示项目/logic/main.bp.json': JSON.stringify(blueprintIR('按钮逻辑', '蓝图已启动')),
          '演示项目/logic/hero.ts': HERO_TS,
        },
      }),
      onPrint: (l) => lines.push(l),
      onError: (m) => errors.push(m),
    })
    await runner.loadAndStart()

    await waitFor(
      () => lines.some((l) => l.includes('已加载 logic/main.bp.json')) && lines.some((l) => l.includes('已加载 logic/hero.ts')),
      '两个绑定都加载',
    )
    await waitFor(
      () => lines.some((l) => l.includes('[蓝图:按钮逻辑] 蓝图已启动')) && lines.some((l) => l.includes('[脚本:英雄逻辑] 脚本已启动')),
      '两个 runtime 的 start 链各自执行（同一 IR 路径）',
    )
    assert.ok(errors.length === 0, `无错误（实际：${errors.join('|')}）`)
    runner.stop()
    handle.destroy()
  })
})
