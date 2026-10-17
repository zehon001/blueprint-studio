/**
 * 运行窗口测试（T1.6 · 任务卡单测清单）
 *
 * 1. buildRuntimeUrl：URL 构造纯函数，中文/路径按 UTF-8 百分号编码且往返无损
 * 2. parseMainUI：project.json 内容 → mainUI 路径；缺 mainUI 字段报中文错
 * 3. 运行窗口 App 加载状态机（happy-dom 挂载冒烟，mock fetch）：
 *    mode=current 成功渲染 / mode=main 经 project.json 解析 / 404 加载失败 /
 *    坏 JSON 解析失败 / 未传 ui 参数 / 重试恢复
 * 4. runtimeWindowTitle：标题生成规则（含运行模式）
 * 另含：F5/F6 启动函数（URL 拼接 / 非 UI tab toast / 弹窗拦截降级 _blank）。
 *
 * 说明：react-dom 需在注入 window/document 之后再求值，故 React 与 RuntimeApp
 * 用顶层 await 动态 import；happy-dom 环境下不用 act，靠轮询等待并发渲染提交。
 *
 * 运行：npx tsx --test src/runtime/runtime.test.ts
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
// 仅类型通道（编译期擦除，不影响下方动态 import 的求值顺序）
import type { OpenWindowFn } from '../shell/runtime-launch'

/* ── happy-dom 环境注入（必须先于 react-dom 求值）────────────── */
const win = new Window()
const doc = win.document
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = doc

/* ── 动态导入（依赖已注入的全局）────────────────────────────── */
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: RuntimeApp, parseRuntimeParams, validateRuntimeParams } = await import('./RuntimeApp')
const {
  buildRuntimeUrl,
  parseMainUI,
  runtimeWindowTitle,
  currentProjectParam,
  launchRuntimeMain,
  launchRuntimeCurrent,
} = await import('../shell/runtime-launch')
const { useWorkspaceStore } = await import('../shell/workspace-store')

/* ── 公共工具 ─────────────────────────────────────────────── */

/** 最小 UI 资产（vbox > button），parseUIAsset 可直接解析 */
function assetText(): string {
  return JSON.stringify({
    version: 2,
    name: 'main',
    root: {
      id: 'ui_root',
      name: 'root',
      type: 'vbox',
      transform: { position: { x: 0, y: 0 }, size: { w: 960, h: 640 }, rotation: 0 },
      theme: {},
      props: {},
      children: [
        {
          id: 'b1',
          name: 'btnGo',
          type: 'button',
          transform: { position: { x: 8, y: 8 }, size: { w: 120, h: 40 }, rotation: 0 },
          theme: {},
          props: { text: '点我' },
          events: [],
          children: [],
        },
      ],
    },
  })
}

/** mock fetch：按完整 URL 查路由；未命中按服务端错误契约返回（记录调用序列） */
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

/** 轮询等待条件成立（并发渲染经调度器异步提交，不用 act 靠轮询观察 DOM） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 挂载 RuntimeApp（每个测试独立容器，互不干扰） */
async function mountApp(props: Record<string, unknown>): Promise<HTMLElement> {
  const c = doc.createElement('div')
  doc.body.appendChild(c)
  // 双跳桥接（仅类型通道）：happy-dom 元素与 DOM lib 类型不兼容，运行时无差异（同 render.test.ts）
  const root = createRoot(c as unknown as Parameters<typeof createRoot>[0])
  root.render(createElement(RuntimeApp, props as never))
  return c as unknown as HTMLElement // 双跳桥接返回（运行时为 happy-dom 元素）
}

/* ══ 1. buildRuntimeUrl：URL 构造纯函数 ═══════════════════════ */

test('buildRuntimeUrl：中文项目名按 UTF-8 百分号编码，mode=main 缺省 ui 不产生参数', () => {
  const url = buildRuntimeUrl({ project: '日志分析器', mode: 'main' })
  assert.equal(url, `/runtime.html?project=${encodeURIComponent('日志分析器')}&mode=main`)
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  assert.equal(q.get('project'), '日志分析器', '解码往返无损')
  assert.equal(q.get('ui'), null, '未传 ui 不带该参数')
  assert.equal(q.get('mode'), 'main')
})

test('buildRuntimeUrl：mode=current 携带 ui 资产路径（含中文与 / 均编码）', () => {
  const url = buildRuntimeUrl({ project: 'MyTool', ui: 'ui/主界面.ui.json', mode: 'current' })
  assert.equal(url, `/runtime.html?project=MyTool&ui=${encodeURIComponent('ui/主界面.ui.json')}&mode=current`)
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  assert.equal(q.get('ui'), 'ui/主界面.ui.json', 'ui 参数往返无损')
  assert.equal(q.get('mode'), 'current')
})

/* ══ 2. parseMainUI：project.json → mainUI ═══════════════════ */

test('parseMainUI：合法 project.json 取 mainUI 路径', () => {
  assert.equal(
    parseMainUI('{"name":"日志分析器","mainUI":"ui/main.ui.json","engineVersion":"2.0.0","plugins":{}}'),
    'ui/main.ui.json',
  )
})

test('parseMainUI：缺 mainUI 字段 / 非字符串 / 坏 JSON 均报中文错误', () => {
  assert.throws(() => parseMainUI('{"name":"没有主UI"}'), /未配置 mainUI/, '缺字段')
  assert.throws(() => parseMainUI('{"mainUI":123}'), /未配置 mainUI/, '非字符串')
  assert.throws(() => parseMainUI('{"mainUI":""}'), /未配置 mainUI/, '空串')
  assert.throws(() => parseMainUI('{bad json'), /project\.json 不是合法 JSON/, '坏 JSON')
})

/* ══ 3. 运行窗口 App 加载状态机（happy-dom 挂载冒烟）══════════ */

test('App 冒烟：mode=current 成功 → renderUI 渲染节点 + 顶栏 + 标题含资产名', async () => {
  document.title = ''
  const calls: string[] = []
  const routes: Record<string, unknown> = {
    [`/api/file?path=${encodeURIComponent('Demo/ui/main.ui.json')}`]: { ok: true, content: assetText() },
  }
  const c = await mountApp({
    params: { project: 'Demo', ui: 'ui/main.ui.json', mode: 'current' },
    fetchImpl: mockFetch(routes, calls),
  })
  await waitFor(() => c.querySelector('[data-uid="b1"]') !== null, '按钮节点渲染')
  assert.equal(c.querySelector<HTMLElement>('[data-uid="b1"]')?.textContent, '点我', 'renderUI 运行态渲染')
  assert.ok(c.querySelector('.runtime-topbar'), '顶部细条存在')
  assert.ok(c.textContent?.includes('当前'), '顶栏含运行模式（当前）')
  assert.ok(c.textContent?.includes('ui/main.ui.json'), '顶栏含资产路径')
  assert.equal(document.title, '运行 · main.ui.json Demo', '标题：运行 · <资产文件名> <项目名>')
  assert.equal(c.querySelector('.runtime-error'), null, '无错误态')
  assert.equal(calls.length, 1, '只请求 UI 资产一次')
  assert.ok(calls[0].includes(encodeURIComponent('Demo/ui/main.ui.json')))
})

test('App 冒烟：mode=main 缺省 ui → 先读 project.json 解析 mainUI 再加载资产', async () => {
  document.title = ''
  const calls: string[] = []
  const routes: Record<string, unknown> = {
    [`/api/file?path=${encodeURIComponent('Demo/project.json')}`]: {
      ok: true,
      content: '{"name":"Demo","mainUI":"ui/main.ui.json"}',
    },
    [`/api/file?path=${encodeURIComponent('Demo/ui/main.ui.json')}`]: { ok: true, content: assetText() },
  }
  const c = await mountApp({ params: { project: 'Demo', ui: null, mode: 'main' }, fetchImpl: mockFetch(routes, calls) })
  await waitFor(() => c.querySelector('[data-uid="b1"]') !== null, '经 mainUI 解析后渲染')
  assert.deepEqual(
    calls.map((u) => decodeURIComponent(u.replace('/api/file?path=', ''))),
    ['Demo/project.json', 'Demo/ui/main.ui.json'],
    '加载顺序：project.json → mainUI 资产',
  )
  assert.equal(document.title, '运行 · 主UI Demo', '标题：运行 · 主UI <项目名>')
  assert.ok(c.textContent?.includes('主UI'), '顶栏含运行模式（主UI）')
})

test('App 冒烟：404 → 全屏中文错误「加载失败」+ 重试按钮', async () => {
  const c = await mountApp({
    params: { project: 'Demo', ui: 'ui/missing.ui.json', mode: 'current' },
    fetchImpl: mockFetch({}),
  })
  await waitFor(() => c.querySelector('.runtime-error') !== null, '错误态出现')
  assert.ok(c.textContent?.includes('加载失败'), '错误信息以「加载失败」开头')
  assert.ok(c.textContent?.includes('文件不存在'), '带出服务端 message')
  const retry = c.querySelector<HTMLButtonElement>('.runtime-error .runtime-btn')
  assert.ok(retry, '重试按钮存在')
  assert.equal(retry?.textContent, '重试')
  assert.equal(c.querySelector('[data-uid]'), null, '错误态不渲染 UI 节点')
})

test('App 冒烟：坏 JSON → 「解析失败」错误态；点重试恢复渲染', async () => {
  const calls: string[] = []
  const routes: Record<string, unknown> = {
    [`/api/file?path=${encodeURIComponent('Demo/ui/main.ui.json')}`]: { ok: true, content: '{bad json' },
  }
  const fetchImpl = mockFetch(routes, calls)
  const c = await mountApp({
    params: { project: 'Demo', ui: 'ui/main.ui.json', mode: 'current' },
    fetchImpl,
  })
  await waitFor(() => c.querySelector('.runtime-error') !== null, '错误态出现')
  assert.ok(c.textContent?.includes('解析失败'), 'parseUIAsset 异常带「解析失败」前缀')

  // 修复路由后点「重试」→ 重新加载 → 渲染成功
  routes[`/api/file?path=${encodeURIComponent('Demo/ui/main.ui.json')}`] = { ok: true, content: assetText() }
  const btn = c.querySelector<HTMLButtonElement>('.runtime-error .runtime-btn')
  assert.ok(btn, '重试按钮存在')
  btn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event)
  await waitFor(() => c.querySelector('[data-uid="b1"]') !== null, '重试后渲染成功')
  assert.equal(c.querySelector('.runtime-error'), null, '错误态退出')
  assert.equal(calls.length, 2, '重试重新请求了一次')
})

test('App 冒烟：mode=current 未传 ui 参数 → 直接中文错误，不发起请求', async () => {
  const calls: string[] = []
  const fetchImpl = mockFetch({}, calls)
  const c = await mountApp({
    params: { project: 'Demo', ui: null, mode: 'current' },
    fetchImpl,
  })
  await waitFor(() => c.querySelector('.runtime-error') !== null, '错误态出现')
  assert.match(c.textContent ?? '', /未传 ui 参数/)
  assert.equal(calls.length, 0, '参数不完整不发起任何请求')
})

test('parseRuntimeParams / validateRuntimeParams：参数解析与校验', () => {
  assert.deepEqual(parseRuntimeParams('?project=Demo&ui=ui%2Fmain.ui.json&mode=current'), {
    project: 'Demo',
    ui: 'ui/main.ui.json',
    mode: 'current',
  })
  // mode 缺省 / 非法 → 按 main
  assert.equal(parseRuntimeParams('?project=Demo')?.mode, 'main')
  assert.equal(parseRuntimeParams('?project=Demo&mode=whatever')?.mode, 'main')
  assert.equal(parseRuntimeParams('?project=Demo')?.ui, null)
  assert.equal(parseRuntimeParams('?ui=ui/main.ui.json'), null, '缺 project 返回 null')
  // 校验：main 可缺省 ui；current 缺 ui 报中文错
  assert.ok(validateRuntimeParams({ project: 'Demo', ui: null, mode: 'main' }).ok, 'main 缺省 ui 合法')
  const bad = validateRuntimeParams({ project: 'Demo', ui: null, mode: 'current' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.message, /未传 ui 参数/)
})

/* ══ 4. runtimeWindowTitle：标题生成规则 ══════════════════════ */

test('标题生成规则：main=「运行 · 主UI 项目名」，current=「运行 · 资产文件名 项目名」', () => {
  assert.equal(runtimeWindowTitle({ mode: 'main', ui: '', project: 'Demo' }), '运行 · 主UI Demo')
  assert.equal(runtimeWindowTitle({ mode: 'main', ui: '', project: '日志分析器' }), '运行 · 主UI 日志分析器')
  assert.equal(runtimeWindowTitle({ mode: 'current', ui: 'ui/main.ui.json', project: 'Demo' }), '运行 · main.ui.json Demo')
  assert.equal(
    runtimeWindowTitle({ mode: 'current', ui: 'ui/子目录/详情.ui.json', project: 'MyTool' }),
    '运行 · 详情.ui.json MyTool',
    '取路径末段为资产文件名',
  )
})

/* ══ 5. F5/F6 启动函数（编辑器侧接线）════════════════════════ */

describe('launchRuntime（F5/F6 共用 handler）', () => {
  beforeEach(() => {
    // 还原 workspace-store（setState replace），并构造：项目 Demo + UI/蓝图两个 tab
    useWorkspaceStore.setState(
      {
        currentProject: { name: 'Demo', path: 'Demo' },
        openTabs: [
          { id: 'ui:ui/main.ui.json', kind: 'ui', assetPath: 'ui/main.ui.json', title: 'main' },
          {
            id: 'blueprint:logic/main.bp.json',
            kind: 'blueprint',
            assetPath: 'logic/main.bp.json',
            title: '蓝图',
          },
        ],
        activeTabId: 'ui:ui/main.ui.json',
      },
    )
  })

  test('currentProjectParam：取当前项目参数值（FS API 首段=项目文件夹名）', () => {
    assert.equal(currentProjectParam(), 'Demo')
    useWorkspaceStore.setState({ currentProject: null })
    assert.equal(currentProjectParam(), null, '未打开项目返回 null')
  })

  test('F5：拼 mode=main 且不带 ui 参数；命名窗口 bps-runtime-main + 980×720', () => {
    const opened: Array<{ url: string; target?: string; features?: string }> = []
    const open: OpenWindowFn = (url, target, features) => {
      opened.push({ url, target, features })
      return { closed: false }
    }
    assert.equal(launchRuntimeMain({ open }), true)
    assert.equal(opened.length, 1)
    assert.equal(opened[0]!.url, '/runtime.html?project=Demo&mode=main')
    assert.equal(opened[0]!.target, 'bps-runtime-main')
    assert.equal(opened[0]!.features, 'width=980,height=720')
  })

  test('F6：激活 tab 是 UI 资产 → 拼 ui 参数 mode=current；非 UI tab → toast「当前 tab 不是 UI」', () => {
    const opened: Array<{ url: string; target?: string }> = []
    const open: OpenWindowFn = (url, target) => {
      opened.push({ url, target })
      return { closed: false }
    }
    assert.equal(launchRuntimeCurrent({ open }), true)
    assert.equal(opened[0]!.url, `/runtime.html?project=Demo&ui=${encodeURIComponent('ui/main.ui.json')}&mode=current`)
    assert.equal(opened[0]!.target, 'bps-runtime-current')

    useWorkspaceStore.setState({ activeTabId: 'blueprint:logic/main.bp.json' })
    const toasts: string[] = []
    assert.equal(launchRuntimeCurrent({ open, toast: (m) => toasts.push(m) }), false, '不打开窗口')
    assert.equal(opened.length, 1, '未新增窗口')
    assert.match(toasts[0] ?? '', /当前 tab 不是 UI/)
  })

  test('弹窗被拦截 → 降级 _blank 新标签页；彻底失败 → toast 且返回 false', () => {
    const targets: Array<string | undefined> = []
    const blockedThenBlank: OpenWindowFn = (_url, target) => {
      targets.push(target)
      return target === '_blank' ? { closed: false } : null // 命名弹窗被拦截
    }
    assert.equal(launchRuntimeMain({ open: blockedThenBlank }), true, '降级 _blank 成功')
    assert.deepEqual(targets, ['bps-runtime-main', '_blank'])

    targets.length = 0
    const alwaysBlocked: OpenWindowFn = () => null
    const toasts: string[] = []
    assert.equal(launchRuntimeMain({ open: alwaysBlocked, toast: (m) => toasts.push(m) }), false)
    assert.match(toasts[0] ?? '', /拦截|无法打开运行窗口/)
  })

  test('未打开项目 → toast「未打开项目」且不打开窗口', () => {
    useWorkspaceStore.setState({ currentProject: null })
    const opened: unknown[] = []
    const toasts: string[] = []
    assert.equal(launchRuntimeMain({ open: () => { opened.push(1); return { closed: false } }, toast: (m) => toasts.push(m) }), false)
    assert.match(toasts[0] ?? '', /未打开项目/)
    assert.equal(opened.length, 0)
  })
})
