/**
 * 插件管理面板单元测试（T6.2 DoD）
 *
 * 覆盖（任务卡「单测」清单逐条）：
 *  1. 状态徽标推导纯函数：installed / updatable / version 组合 → 四态映射
 *     （含 detect 失败=未安装、无 detect=自定义、updatable 缺省时本地版本比较兜底）；
 *  2. SSE 消费：mock fetch + ReadableStream（不用 EventSource——SSE 走 fetch 流解析，
 *     跨浏览器统一）解析 log/done/error 事件序列 → 结束方式与日志行正确、可 abort；
 *  3. 并发节流 detect（runPool 并发 3 池：最大并发、结果顺序、失败不中断）；
 *  4. 组件冒烟：happy-dom 挂载（mock 数据 3 插件三源）→ 行渲染 / 徽标 / 按钮 disabled 态
 *     （已安装·最新 → 更新置灰）/ 展开详情 / 警告条 / 在编辑器中打开；
 *  5. 取消安装：abort 后状态复位（日志区收起、按钮恢复、toast 提示）。
 *
 * 运行：npx tsx --test src/panels/plugin-manager/plugin-manager.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginManifest } from '@/ir/types'
import {
  BADGE_LABEL,
  compareVersions,
  deriveStatus,
  installCommandText,
  resolveUpdatable,
  runPool,
  strategyLabel,
  type DetectEntry,
  type DetectResult,
} from './model'
import { consumeSseBody, createSseParser, parseInstallEvent, type InstallStreamEvent } from './sse'
import { createPluginApi, PluginApiError, type FetchLike, type PluginApi } from './api'

/* ============================================================
 * happy-dom 环境（必须先于 react-dom / 组件加载）
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
const { PluginManagerPanel } = await import('./PluginManagerPanel')
const { useWorkspaceStore } = await import('@/shell/workspace-store')

/* ============================================================
 * 测试数据与工具
 * ============================================================ */

/** phone-log（内置 · cli · 可更新形态） */
function phoneLogManifest(): PluginManifest {
  return {
    id: 'phone-log',
    name: '手机日志',
    kind: 'cli',
    description: 'adb 读取手机日志 / 解析 Android 日志文件',
    detect: { cmd: 'adb version', versionRegex: 'Android Debug Bridge version ([\\d.]+)' },
    install: { strategy: 'winget', args: ['Google.PlatformTools'] },
    update: { latestVersion: '35.0', source: 'registry' },
    nodes: [
      {
        id: 'phoneLog.read',
        title: '读取手机日志',
        category: '插件',
        inputs: [{ id: 'exec', type: 'exec' }, { id: 'mode', type: 'string' }],
        outputs: [{ id: 'exec', type: 'exec' }, { id: 'rows', type: 'LogRow[]' }],
      },
      {
        id: 'phoneLog.onLine',
        title: '手机日志·新行',
        category: '插件',
        kind: 'event',
        inputs: [],
        outputs: [{ id: 'exec', type: 'exec' }, { id: 'line', type: 'string' }],
      },
    ],
    source: 'builtin',
  }
}

/** feishu-cli（项目 · cli · 已安装·最新形态） */
function feishuManifest(): PluginManifest {
  return {
    id: 'feishu-cli',
    name: '飞书 CLI',
    kind: 'cli',
    description: '飞书消息推送 CLI 封装',
    detect: { cmd: 'lark --version' },
    install: { strategy: 'npm-global', args: ['@larksuiteoapi/lark-cli'] },
    update: { latestVersion: '1.0', source: 'registry' },
    nodes: [],
    source: 'project',
  }
}

/** my-tool（静态目录 · custom · 无 detect → 自定义形态） */
function myToolManifest(): PluginManifest {
  return {
    id: 'my-tool',
    name: '我的工具插件',
    kind: 'custom',
    description: '本地自定义插件',
    nodes: [
      {
        id: 'myTool.hello',
        title: '打个招呼',
        category: '插件',
        inputs: [{ id: 'exec', type: 'exec' }, { id: 'name', type: 'string', optional: true }],
        outputs: [{ id: 'exec', type: 'exec' }],
      },
    ],
    source: 'static',
  }
}

/** zip-tool（静态目录 · cli · 未安装形态） */
function zipToolManifest(): PluginManifest {
  return {
    id: 'zip-tool',
    name: '压缩工具',
    kind: 'cli',
    description: 'ZIP 打包 CLI 封装',
    detect: { cmd: '7z --help' },
    install: { strategy: 'winget', args: ['7zip.7zip'] },
    nodes: [],
    source: 'static',
  }
}

/** JSON 响应 stub */
function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as unknown as Response
}

/** 组件测试的 mock API（记录调用 + 可配置 detect 结果 / 安装流行为） */
interface MockState {
  calls: { list: string[]; detect: string[]; install: string[] }
  manifests: PluginManifest[]
  warnings: string[]
  detectResults: Record<string, DetectResult | Error>
  /** 自定义安装流行为（缺省：1 条日志 + done） */
  startInstall?: (o: Parameters<PluginApi['startInstall']>[0]) => Promise<'done' | 'error' | 'aborted' | 'closed'>
}

function createMockApi(s: MockState): PluginApi {
  return {
    async list(project) {
      s.calls.list.push(project ?? '(无项目)')
      return { manifests: s.manifests, warnings: s.warnings }
    },
    async detect(id, project) {
      s.calls.detect.push(`${id}@${project ?? '(无项目)'}`)
      const r = s.detectResults[id]
      if (r instanceof Error) throw r
      if (r) return r
      return { ok: true, installed: false }
    },
    async startInstall(o) {
      s.calls.install.push(`${o.pluginId}@${o.action}@${o.project ?? '(无项目)'}`)
      if (s.startInstall) return s.startInstall(o)
      o.onEvent({ type: 'log', line: 'mock 日志行' })
      o.onEvent({ type: 'done' })
      return 'done'
    },
  }
}

function freshCalls(): MockState['calls'] {
  return { list: [], detect: [], install: [] }
}

/** 挂载面板（注入 mock api）；flush 用宏任务冲刷全部微任务链（fetch / detect 池） */
async function mountPanel(api: PluginApi): Promise<{ flush: () => Promise<void>; unmount: () => Promise<void> }> {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => {
    root.render(createElement(PluginManagerPanel, { api }))
  })
  return {
    async flush() {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/**
 * 在 act 内派发 click（happy-dom Event 体系；参数宽松类型桥接
 * happy-dom Element 与 TS DOM lib Element 的结构差异，见 file-system.test.ts 双跳惯例）。
 */
async function click(el: unknown): Promise<void> {
  await act(async () => {
    ;(el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(
      new dom.MouseEvent('click', { bubbles: true, cancelable: true }),
    )
  })
}

/**
 * 查询助手：返回 any 桥接 happy-dom 的 Element 与 TS DOM lib 的 Element 结构差异；
 * 具体元素在使用处按需断言为 HTMLButtonElement 等取属性。
 */
function q(selector: string): any {
  return dom.document.querySelector(selector)
}

function qAll(selector: string): any[] {
  return [...dom.document.querySelectorAll(selector)]
}

/* ============================================================
 * 1. 状态徽标推导（纯函数）
 * ============================================================ */

describe('状态徽标推导 deriveStatus（四态映射）', () => {
  const withDetect = { detect: { cmd: 'adb version' } }
  const noDetect = {}

  it('清单无 detect → 自定义（自定义插件不做检测）', () => {
    const entry: DetectEntry = { phase: 'checking' }
    const st = deriveStatus(noDetect, entry)
    assert.equal(st.state, 'custom')
    assert.equal(BADGE_LABEL.custom, '自定义')
  })

  it('检测中 → checking 过渡态', () => {
    const st = deriveStatus(withDetect, { phase: 'checking' })
    assert.equal(st.state, 'checking')
  })

  it('detect 失败 = 未安装（带原因）', () => {
    const st = deriveStatus(withDetect, { phase: 'settled', failure: '命令不可执行' })
    assert.equal(st.state, 'not-installed')
    assert.equal(st.message, '检测失败：命令不可执行')
  })

  it('installed=false → 未安装', () => {
    const st = deriveStatus(withDetect, {
      phase: 'settled',
      result: { ok: true, installed: false },
    })
    assert.equal(st.state, 'not-installed')
    assert.equal(BADGE_LABEL['not-installed'], '未安装')
  })

  it('installed=true + updatable=true → 可更新（版本透传）', () => {
    const st = deriveStatus(withDetect, {
      phase: 'settled',
      result: { ok: true, installed: true, version: '34.0', latest: '35.0', updatable: true },
    })
    assert.equal(st.state, 'updatable')
    assert.equal(st.version, '34.0')
    assert.equal(st.latest, '35.0')
    assert.equal(BADGE_LABEL.updatable, '可更新')
  })

  it('installed=true + updatable=false → 已安装·最新', () => {
    const st = deriveStatus(withDetect, {
      phase: 'settled',
      result: { ok: true, installed: true, version: '35.0', updatable: false },
    })
    assert.equal(st.state, 'up-to-date')
    assert.equal(BADGE_LABEL['up-to-date'], '已安装·最新')
  })

  it('updatable 缺省 → 本地版本比较兜底：旧版 → 可更新', () => {
    const st = deriveStatus(withDetect, {
      phase: 'settled',
      result: { ok: true, installed: true, version: '34.0', latest: '35.0' },
    })
    assert.equal(st.state, 'updatable')
  })

  it('updatable 缺省 → 本地版本比较兜底：已是最新 → 已安装·最新', () => {
    const st = deriveStatus(withDetect, {
      phase: 'settled',
      result: { ok: true, installed: true, version: '35.0', latest: '35.0' },
    })
    assert.equal(st.state, 'up-to-date')
  })

  it('updatable 缺省且无版本信息 → 保守按已安装·最新（不乱报可更新）', () => {
    const st = deriveStatus(withDetect, {
      phase: 'settled',
      result: { ok: true, installed: true },
    })
    assert.equal(st.state, 'up-to-date')
  })
})

describe('compareVersions 与 resolveUpdatable', () => {
  it('点分段数值比较（1.10 > 1.9；缺失段按 0；容忍 v 前缀）', () => {
    assert.equal(compareVersions('34.0', '35.0'), -1)
    assert.equal(compareVersions('35.0', '34.0'), 1)
    assert.equal(compareVersions('35.0', '35.0'), 0)
    assert.equal(compareVersions('1.10', '1.9'), 1)
    assert.equal(compareVersions('35', '35.0'), 0)
    assert.equal(compareVersions('v2.1', '2.1'), 0)
  })

  it('resolveUpdatable：服务端值优先，缺省本地比较，信息不全保守 false', () => {
    assert.equal(resolveUpdatable({ ok: true, installed: true, updatable: false, version: '1.0', latest: '9.0' }), false)
    assert.equal(resolveUpdatable({ ok: true, installed: true, version: '1.0', latest: '2.0' }), true)
    assert.equal(resolveUpdatable({ ok: true, installed: true }), false)
  })
})

describe('installCommandText（确认对话框命令文本）', () => {
  it('detect 返回带 cmd → 直接显示该命令', () => {
    const m = { install: { strategy: 'winget' as const, args: ['Google.PlatformTools'] } }
    const d: DetectResult = { ok: true, installed: true, cmd: 'winget install Google.PlatformTools' }
    assert.equal(installCommandText(m, d), 'winget install Google.PlatformTools')
  })

  it('无 cmd → 显示策略名 + 参数', () => {
    const m = { install: { strategy: 'winget' as const, args: ['Google.PlatformTools'] } }
    assert.equal(installCommandText(m, null), '安装策略：winget 安装（参数：Google.PlatformTools）')
  })

  it('custom-cmd → 显示清单里的自定义命令；无 install → null', () => {
    assert.equal(installCommandText({ install: { strategy: 'custom-cmd', cmd: 'my-install --all' } }, null), 'my-install --all')
    assert.equal(installCommandText({}, null), null)
  })

  it('strategyLabel 中文映射', () => {
    assert.equal(strategyLabel('winget'), 'winget 安装')
    assert.equal(strategyLabel('npm-global'), 'npm 全局安装')
    assert.equal(strategyLabel('download-zip'), '下载 ZIP 安装')
    assert.equal(strategyLabel('custom-cmd'), '自定义命令')
    assert.equal(strategyLabel('unknown-x'), 'unknown-x')
  })
})

/* ============================================================
 * 2. SSE 解析与消费（fetch 流解析，不用 EventSource）
 * ============================================================ */

describe('createSseParser（增量帧解析）', () => {
  it('单 chunk 完整帧', () => {
    const frames: string[] = []
    const p = createSseParser((d) => frames.push(d))
    p.push('data: {"type":"log","line":"a"}\n\ndata: {"type":"log","line":"b"}\n\n')
    assert.deepEqual(frames, ['{"type":"log","line":"a"}', '{"type":"log","line":"b"}'])
  })

  it('跨 chunk 任意字节拆分', () => {
    const frames: string[] = []
    const p = createSseParser((d) => frames.push(d))
    p.push('data: {"type":"lo')
    p.push('g","line":"c"}\n')
    p.push('\n')
    assert.deepEqual(frames, ['{"type":"log","line":"c"}'])
  })

  it('多 data 行以 \\n 合并为一帧', () => {
    const frames: string[] = []
    const p = createSseParser((d) => frames.push(d))
    p.push('data: line1\ndata: line2\n\n')
    assert.deepEqual(frames, ['line1\nline2'])
  })

  it('注释 / 心跳行与 event/id/retry 字段忽略；容忍 CRLF', () => {
    const frames: string[] = []
    const p = createSseParser((d) => frames.push(d))
    p.push(': ping\r\n\r\nevent: install\r\ndata: x\r\n\r\n')
    assert.deepEqual(frames, ['x'])
  })

  it('end() 冲刷未收到空行收尾的残留帧', () => {
    const frames: string[] = []
    const p = createSseParser((d) => frames.push(d))
    p.push('data: tail')
    assert.deepEqual(frames, [])
    p.end()
    assert.deepEqual(frames, ['tail'])
  })
})

describe('parseInstallEvent（data JSON → 事件）', () => {
  it('log / done / error 三型', () => {
    assert.deepEqual(parseInstallEvent('{"type":"log","line":"x"}'), { type: 'log', line: 'x' })
    const done = parseInstallEvent('{"type":"done"}')
    assert.equal(done.type, 'done')
    const err = parseInstallEvent('{"type":"error","message":"坏了"}')
    assert.deepEqual(err, { type: 'error', message: '坏了' })
  })

  it('非 JSON / 未知形态帧 → 降级为原始文本 log 行（不丢帧）', () => {
    assert.deepEqual(parseInstallEvent('不是 JSON'), { type: 'log', line: '不是 JSON' })
    const odd = parseInstallEvent('{"type":"unknown"}')
    assert.equal(odd.type, 'log')
  })
})

/** 构造 SSE 响应体（node 全局 ReadableStream；complete=读完即关，hang=挂起、abort 时报错） */
function sseBody(frames: string[], mode: 'complete' | 'hang', signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      if (mode === 'complete') controller.close()
      else if (signal) {
        signal.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        })
      }
    },
  })
}

describe('consumeSseBody（mock ReadableStream 消费）', () => {
  it('log/log/done 序列 → outcome done，日志行依次交付', async () => {
    const events: InstallStreamEvent[] = []
    const outcome = await consumeSseBody(
      sseBody(
        ['data: {"type":"log","line":"第 1 行"}\n\n', 'data: {"type":"log","line":"第 2 行"}\n\n', 'data: {"type":"done"}\n\n'],
        'complete',
      ),
      (e) => events.push(e),
    )
    assert.equal(outcome, 'done')
    assert.equal(events.length, 3)
    assert.deepEqual(events[0], { type: 'log', line: '第 1 行' })
    assert.deepEqual(events[1], { type: 'log', line: '第 2 行' })
    assert.equal(events[2].type, 'done')
  })

  it('error 事件 → outcome error 且 message 交付', async () => {
    const events: InstallStreamEvent[] = []
    const outcome = await consumeSseBody(
      sseBody(['data: {"type":"log","line":"开始"}\n\n', 'data: {"type":"error","message":"下载失败"}\n\n'], 'complete'),
      (e) => events.push(e),
    )
    assert.equal(outcome, 'error')
    assert.deepEqual(events[1], { type: 'error', message: '下载失败' })
  })

  it('流中途 abort → outcome aborted', async () => {
    const events: InstallStreamEvent[] = []
    const controller = new AbortController()
    const pending = consumeSseBody(
      sseBody(['data: {"type":"log","line":"a"}\n\n'], 'hang', controller.signal),
      (e) => events.push(e),
      controller.signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 10)) // 读走首帧、read 挂起
    controller.abort()
    assert.equal(await pending, 'aborted')
    assert.equal(events.length, 1)
  })

  it('body 为空 → outcome closed', async () => {
    const outcome = await consumeSseBody(null, () => {})
    assert.equal(outcome, 'closed')
  })
})

describe('api 层（URL 构造 / 错误映射 / 安装流接线）', () => {
  it('list：带 project 与不带 project 的 URL（未开项目不带参数）', async () => {
    const urls: string[] = []
    const api = createPluginApi(async (input) => {
      urls.push(String(input))
      return jsonResponse({ ok: true, manifests: [phoneLogManifest()], warnings: [] })
    })
    const withProject = await api.list('MyTool')
    assert.equal(urls[0], '/api/plugins?project=MyTool')
    assert.equal(withProject.manifests.length, 1)
    const without = await api.list(null)
    assert.equal(urls[1], '/api/plugins')
    assert.deepEqual(without.warnings, [])
  })

  it('detect：POST /api/plugins/:id/detect?project=，返回 DetectResult', async () => {
    const calls: { url: string; method: string }[] = []
    const api = createPluginApi(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' })
      return jsonResponse({ ok: true, installed: true, version: '34.0', updatable: true })
    })
    const r = await api.detect('phone-log', 'MyTool')
    assert.deepEqual(calls, [{ url: '/api/plugins/phone-log/detect?project=MyTool', method: 'POST' }])
    assert.equal(r.installed, true)
    assert.equal(r.version, '34.0')
  })

  it('服务端 ok=false / HTTP 非 200 → PluginApiError（中文 message）', async () => {
    const api = createPluginApi(async (input) => {
      if (String(input).includes('detect')) return jsonResponse({ ok: false, message: '执行失败' })
      return jsonResponse({}, false, 500)
    })
    await assert.rejects(api.detect('a', null), (e: unknown) => e instanceof PluginApiError && e.message === '执行失败')
    await assert.rejects(api.list(null), (e: unknown) => e instanceof PluginApiError && e.status === 500)
  })

  it('startInstall：GET .../install?project=&action=install|update，SSE 结果经 consumeSseBody', async () => {
    const urls: string[] = []
    const api = createPluginApi(async (input) => {
      urls.push(String(input))
      return { ok: true, status: 200, body: sseBody(['data: {"type":"done"}\n\n'], 'complete') } as unknown as Response
    })
    const events: InstallStreamEvent[] = []
    const o1 = await api.startInstall({
      pluginId: 'phone-log',
      action: 'install',
      project: 'My Tool',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    })
    assert.equal(urls[0], '/api/plugins/phone-log/install?project=My%20Tool&action=install')
    assert.equal(o1, 'done')
    const o2 = await api.startInstall({
      pluginId: 'phone-log',
      action: 'update',
      project: null,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    })
    assert.equal(urls[1], '/api/plugins/phone-log/install?action=update')
    assert.equal(o2, 'done')
  })
})

/* ============================================================
 * 3. 并发节流池（detect 并发 3）
 * ============================================================ */

describe('runPool 并发节流池', () => {
  it('6 任务限 3：最大并发 = 3，结果按任务顺序', async () => {
    let active = 0
    let maxActive = 0
    const makeTask = (i: number) => async (): Promise<number> => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return i * 10
    }
    const results = await runPool([0, 1, 2, 3, 4, 5].map(makeTask), 3)
    assert.equal(maxActive, 3, '并发上限应为 3')
    assert.equal(results.length, 6)
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
      [0, 10, 20, 30, 40, 50],
    )
    assert.ok(results.every((r) => r.status === 'fulfilled'))
  })

  it('任务数少于上限 / 任务失败不中断其余任务', async () => {
    const ok = await runPool([async () => 1, async () => 2], 3)
    assert.deepEqual(
      ok.map((r) => (r.status === 'fulfilled' ? r.value : null)),
      [1, 2],
    )
    const mixed = await runPool(
      [async () => 'a', async () => { throw new Error('boom') }, async () => 'c'],
      2,
    )
    assert.equal(mixed[0].status, 'fulfilled')
    assert.equal(mixed[1].status, 'rejected')
    assert.equal(mixed[2].status, 'fulfilled')
  })

  it('空任务表 → 空结果', async () => {
    assert.deepEqual(await runPool([], 3), [])
  })
})

/* ============================================================
 * 4. 组件冒烟（happy-dom 挂载：3 插件三源 / 徽标 / disabled / 展开详情）
 * ============================================================ */

describe('PluginManagerPanel 组件冒烟', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ currentProject: { name: 'MyTool', path: 'MyTool' }, openTabs: [], activeTabId: null })
  })

  afterEach(() => {
    dom.document.body.innerHTML = ''
    useWorkspaceStore.setState({ currentProject: null, openTabs: [], activeTabId: null })
  })

  it('行渲染 / 徽标四态 / 按钮 disabled 态 / detect 并发调用', async () => {
    const state: MockState = {
      calls: freshCalls(),
      manifests: [phoneLogManifest(), feishuManifest(), myToolManifest()],
      warnings: [],
      detectResults: {
        'phone-log': { ok: true, installed: true, version: '34.0', latest: '35.0', updatable: true },
        'feishu-cli': { ok: true, installed: true, version: '1.0', latest: '1.0', updatable: false },
      },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()

    // 行渲染：3 插件 3 行，来源徽标三色齐
    assert.equal(qAll('.pm-item').length, 3)
    assert.ok(q('.pm-badge-source.source-builtin'), '内置徽标应存在')
    assert.ok(q('.pm-badge-source.source-project'), '项目徽标应存在')
    assert.ok(q('.pm-badge-source.source-static'), '静态目录徽标应存在')
    assert.ok(qAll('.pm-badge-source').every((el) => ['内置', '项目', '静态目录'].some((t) => el.textContent?.includes(t))))

    // detect：仅无 detect 清单外的两项被调用，且带 project 参数
    assert.deepEqual(state.calls.detect.sort(), ['feishu-cli@MyTool', 'phone-log@MyTool'])

    // phone-log：可更新（黄）徽标显示 当前版 → 最新版，更新按钮可点
    const phone = q('[data-plugin-id="phone-log"]')
    assert.ok(phone, 'phone-log 行应存在')
    assert.ok(phone?.querySelector('.pm-badge.state-updatable'))
    assert.match(phone?.querySelector('.pm-badge.state-updatable')?.textContent ?? '', /34\.0 → 35\.0/)
    assert.equal(phone?.querySelector('.pm-version')?.textContent, '34.0')
    const phoneUpdate = phone?.querySelector('.pm-btn[data-action="update"]') as HTMLButtonElement
    assert.ok(phoneUpdate, 'phone-log 更新按钮应存在')
    assert.equal(phoneUpdate.disabled, false)

    // feishu-cli：已安装·最新（绿），更新按钮置灰 disabled（DoD 硬性）
    const feishu = q('[data-plugin-id="feishu-cli"]')
    assert.ok(feishu?.querySelector('.pm-badge.state-up-to-date'))
    const feishuUpdate = feishu?.querySelector('.pm-btn[data-action="update"]') as HTMLButtonElement
    assert.ok(feishuUpdate, 'feishu-cli 更新按钮应渲染')
    assert.equal(feishuUpdate.disabled, true, '已安装·最新时更新按钮必须 disabled')

    // my-tool：自定义（蓝），无安装/更新按钮，显示重载
    const myTool = q('[data-plugin-id="my-tool"]')
    assert.ok(myTool?.querySelector('.pm-badge.state-custom'))
    assert.equal(myTool?.querySelector('.pm-btn[data-action="install"]'), null)
    assert.equal(myTool?.querySelector('.pm-btn[data-action="update"]'), null)
    const reload = myTool?.querySelector('.pm-btn[data-action="reload"]') as HTMLButtonElement
    assert.ok(reload, '自定义插件应显示重载按钮')
    assert.equal(reload.textContent?.includes('重载'), true)

    // 配套节点数
    assert.match(phone?.querySelector('.pm-nodecount')?.textContent ?? '', /2 节点/)
    assert.match(myTool?.querySelector('.pm-nodecount')?.textContent ?? '', /1 节点/)

    // 名称与描述
    assert.match(phone?.querySelector('.pm-name')?.textContent ?? '', /手机日志/)

    await h.unmount()
  })

  it('点击行展开节点详情（节点名 / 引脚 / 类型）', async () => {
    const state: MockState = {
      calls: freshCalls(),
      manifests: [phoneLogManifest()],
      warnings: [],
      detectResults: { 'phone-log': { ok: true, installed: false } },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()

    assert.equal(q('.pm-details'), null, '未展开前无详情')
    const row = q('[data-plugin-id="phone-log"] .pm-row')
    assert.ok(row)
    await click(row)
    await h.flush()

    const titles = qAll('.pm-node-title').map((el) => el.textContent)
    assert.deepEqual(titles, ['读取手机日志', '手机日志·新行'])
    assert.ok(q('.pm-node-kind'), '持续流事件节点应有 kind 标记')
    const pins = qAll('.pm-pin-group').map((el) => el.textContent ?? '').join('\n')
    assert.match(pins, /exec:exec/)
    assert.match(pins, /mode:string/)
    assert.match(pins, /rows:LogRow\[\]/)
    // 再点一次收起
    await click(q('[data-plugin-id="phone-log"] .pm-row') as Element)
    assert.equal(q('.pm-details'), null)
    await h.unmount()
  })

  it('警告条：清单损坏等 warnings 显示在列表顶部', async () => {
    const state: MockState = {
      calls: freshCalls(),
      manifests: [phoneLogManifest()],
      warnings: ['内置清单 bad.json 校验失败，已跳过：缺少必填字段 name'],
      detectResults: { 'phone-log': { ok: true, installed: false } },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()
    const warn = q('.pm-warnings')
    assert.ok(warn, '警告条应存在')
    assert.match(warn?.textContent ?? '', /bad\.json/)
    assert.ok(q('.pm-item'), '警告不影响列表渲染')
    await h.unmount()
  })

  it('v3 T8.3：不再有「在编辑器中打开」虚拟 tab 入口，提示迁入设置弹窗', async () => {
    const state: MockState = {
      calls: freshCalls(),
      manifests: [phoneLogManifest()],
      warnings: [],
      detectResults: { 'phone-log': { ok: true, installed: false } },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()
    const btn = [...dom.document.querySelectorAll('.pm-header-btn')].find((el) =>
      el.textContent?.includes('在编辑器中打开'),
    )
    assert.equal(btn, undefined, '设置弹窗化后不应再有虚拟 tab 入口')
    assert.match(q('.pm-footer-hint')?.textContent ?? '', /设置 → 插件/)
    assert.equal(
      useWorkspaceStore.getState().openTabs.some((t) => (t.kind as string) === 'plugin-manager'),
      false,
    )
    await h.unmount()
  })

  it('未打开项目：list 不带 project 参数且头部提示', async () => {
    useWorkspaceStore.setState({ currentProject: null })
    const state: MockState = {
      calls: freshCalls(),
      manifests: [phoneLogManifest()],
      warnings: [],
      detectResults: { 'phone-log': { ok: true, installed: false } },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()
    assert.deepEqual(state.calls.list, ['(无项目)'])
    assert.match(q('.pm-header-project')?.textContent ?? '', /未打开项目/)
    await h.unmount()
  })
})

/* ============================================================
 * 5. 安装 / 更新交互与取消
 * ============================================================ */

describe('安装 / 更新交互', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ currentProject: { name: 'MyTool', path: 'MyTool' }, openTabs: [], activeTabId: null })
  })

  afterEach(() => {
    dom.document.body.innerHTML = ''
    useWorkspaceStore.setState({ currentProject: null, openTabs: [], activeTabId: null })
  })

  it('确认对话框显示将执行的命令 → 确认后 SSE 日志 / done 重跑 detect / toast 成功', async () => {
    const state: MockState = {
      calls: freshCalls(),
      manifests: [zipToolManifest()],
      warnings: [],
      detectResults: { 'zip-tool': { ok: true, installed: false } },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()

    // 未安装 → 下载 / 安装按钮
    const installBtn = q('[data-plugin-id="zip-tool"] .pm-btn[data-action="install"]') as HTMLButtonElement
    assert.ok(installBtn, '未安装应显示 下载 / 安装 按钮')
    assert.match(installBtn.textContent ?? '', /下载 \/ 安装/)
    assert.equal(installBtn.disabled, false)

    // 点击 → 确认对话框（detect 无 cmd → 显示策略名）
    await click(installBtn)
    const dialog = q('.pm-confirm')
    assert.ok(dialog, '应弹出确认对话框')
    const cmd = q('.pm-confirm-cmd')?.textContent ?? ''
    assert.match(cmd, /winget/)
    assert.match(cmd, /7zip\.7zip/)

    // 确认安装 → 内嵌日志区 + done → 重跑 detect + toast 成功
    const detectCallsBefore = state.calls.detect.length
    await click(q('.pm-confirm-actions .pm-btn.primary') as Element)
    await h.flush()
    assert.deepEqual(state.calls.install, ['zip-tool@install@MyTool'])
    const log = q('.pm-log')
    assert.ok(log, '内嵌日志区应出现')
    assert.match(q('.pm-log-line')?.textContent ?? '', /mock 日志行/)
    assert.ok(q('.pm-toast.success'), '应有成功 toast')
    assert.match(q('.pm-toast.success')?.textContent ?? '', /安装完成/)
    assert.ok(state.calls.detect.length > detectCallsBefore, 'done 后应重跑 detect')
    assert.ok(q('.pm-badge.state-not-installed'), 'detect 未变化时仍显示未安装（mock 固定）')
    assert.ok([...dom.document.querySelectorAll('.pm-btn.small')].some((el) => el.textContent?.includes('关闭日志')))
    await h.unmount()
  })

  it('error 事件 → 日志 error 行红色样式 + toast 失败', async () => {
    const state: MockState = {
      calls: freshCalls(),
      manifests: [zipToolManifest()],
      warnings: [],
      detectResults: { 'zip-tool': { ok: true, installed: false } },
      startInstall: async (o) => {
        o.onEvent({ type: 'log', line: '开始下载…' })
        o.onEvent({ type: 'error', message: '下载失败（网络不可达）' })
        return 'error'
      },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()
    await click(q('[data-plugin-id="zip-tool"] .pm-btn[data-action="install"]') as Element)
    await click(q('.pm-confirm-actions .pm-btn.primary') as Element)
    await h.flush()
    const errLine = q('.pm-log-line.error')
    assert.ok(errLine, 'error 行应存在')
    assert.match(errLine?.textContent ?? '', /下载失败（网络不可达）/)
    assert.ok(q('.pm-toast.error'), '应有失败 toast')
    assert.match(q('.pm-toast.error')?.textContent ?? '', /安装失败/)
    await h.unmount()
  })

  it('取消安装：abort 后状态复位（日志区收起 / 按钮恢复 / toast 提示）', async () => {
    // 真实 fetch mock：list / detect 走 JSON，install 走挂起的 SSE 流（abort 时 read 报 AbortError）
    const encoder = new TextEncoder()
    const urls: string[] = []
    const fetchLike: FetchLike = async (input, init) => {
      const url = String(input)
      if (url === '/api/plugins' || url.startsWith('/api/plugins?')) {
        return jsonResponse({ ok: true, manifests: [zipToolManifest()], warnings: [] })
      }
      if (url.includes('/detect')) return jsonResponse({ ok: true, installed: false })
      urls.push(url)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"log","line":"正在下载 7zip…"}\n\n'))
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          })
        },
      })
      return { ok: true, status: 200, body } as unknown as Response
    }
    const h = await mountPanel(createPluginApi(fetchLike))
    await h.flush()

    await click(q('[data-plugin-id="zip-tool"] .pm-btn[data-action="install"]') as Element)
    await click(q('.pm-confirm-actions .pm-btn.primary') as Element)
    await h.flush()

    // 安装中：请求 URL 正确、日志已到、运行中标题 + 停止按钮
    assert.equal(urls[0], '/api/plugins/zip-tool/install?project=MyTool&action=install')
    assert.match(q('.pm-log-line')?.textContent ?? '', /正在下载 7zip…/)
    assert.ok(q('.pm-job-title.running'), '应显示安装中')
    const stopBtn = [...dom.document.querySelectorAll('.pm-btn.small.danger')].find((el) =>
      el.textContent?.includes('停止'),
    )
    assert.ok(stopBtn, '应有「停止」按钮')

    // 点击停止 → abort → 状态复位
    await click(stopBtn)
    await h.flush()
    assert.equal(q('.pm-job'), null, '取消后安装日志区应收起（状态复位）')
    assert.ok(q('.pm-toast.info'), '应有「已停止」提示')
    assert.match(q('.pm-toast.info')?.textContent ?? '', /已停止/)
    const installBtn = q('[data-plugin-id="zip-tool"] .pm-btn[data-action="install"]') as HTMLButtonElement
    assert.ok(installBtn, '取消后安装按钮恢复')
    assert.equal(installBtn.disabled, false, '取消后安装按钮应可再点')
    await h.unmount()
  })

  it('安装中行按钮防重入（再次点击不产生第二个安装流）', async () => {
    let starts = 0
    const state: MockState = {
      calls: freshCalls(),
      manifests: [zipToolManifest()],
      warnings: [],
      detectResults: { 'zip-tool': { ok: true, installed: false } },
      startInstall: async () => {
        starts++
        await new Promise((resolve) => setTimeout(resolve, 20)) // 挂一会儿
        return 'done'
      },
    }
    const h = await mountPanel(createMockApi(state))
    await h.flush()
    await click(q('[data-plugin-id="zip-tool"] .pm-btn[data-action="install"]') as Element)
    await click(q('.pm-confirm-actions .pm-btn.primary') as Element)
    // 安装未结束期间再次点击确认入口（按钮此时应 disabled）
    const installBtn = q('[data-plugin-id="zip-tool"] .pm-btn[data-action="install"]') as HTMLButtonElement
    assert.equal(installBtn.disabled, true, '安装中行按钮应 disabled 防重入')
    await h.flush()
    assert.equal(starts, 1, '只应发起一次安装')
    await h.unmount()
  })
})
