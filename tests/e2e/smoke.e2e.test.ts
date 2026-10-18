/**
 * Blueprint Studio v2 —— TA.2 E2E 冒烟（PLAN §20.3 场景脚本化，可重复执行）
 *
 * 定位：直连本地服务 API 链路的可重复冒烟（node:http/fetch，不启 vite、不开浏览器——
 * 浏览器层冒烟由 PM 实机走查覆盖）。对应 PLAN §20-3「手机日志场景 E2E」的 API 段：
 * 新建项目（log-analyzer 模板）→ 写 UI 资产 → 写蓝图资产（forLoop + print，ADR-008）→
 * 转译诊断 → 插件注册表 → 保存前快照（依赖 T7.4）。
 *
 * 跑法：npm run e2e（前置：npm run server 已在 8790 端口运行）。
 * 服务不可达时全部场景自动 skip 并提示「启动 npm run server 后重跑」——CI / 无服务环境不红。
 * 可用环境变量 BP_E2E_BASE 覆盖服务地址（默认 http://localhost:8790），用于无服务环境验证 skip 路径。
 *
 * 隔离与清理：每场景独立项目名 e2e-smoke-<时间戳>-<场景>；测试结束后统一删除项目目录
 * （服务端无「删项目」API，经 /api/health 返回的 projectsRoot 直接 fs.rmSync——仅删本测试
 * 自建目录，不影响其他项目）。
 *
 * 场景③的 ADR-008 语义验证分两层：API 写读 + serializeIR/deserializeIR JSON 往返无损；
 * 另在进程内直接 createRuntime 执行写盘蓝图，观察 print 输出 0,1,2（forLoop 一次触发
 * 跑完迭代、循环体无需回连——UE5 语义，解释器为节点库真源注入，不依赖浏览器）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { serializeIR, deserializeIR, validateIR } from '../../src/ir/validate'
import { builtinSpecMap } from '../../src/nodes'
import { createRuntime } from '../../src/runtime/interpreter/interpreter'

/* ============================================================
 * 前置探测：服务可达性（不可达 → 全部场景 skip）
 * ============================================================ */

const BASE_URL = process.env.BP_E2E_BASE ?? 'http://localhost:8790'
const SKIP_SERVER_DOWN = `本地服务不可达（${BASE_URL}/api/health）：启动 npm run server 后重跑`
const SKIP_T74 = '/api/history 未落地：依赖 T7.4（.history 保存前快照）——落地后补充覆盖'

let serverUp = false
/** 项目安全根（/api/health 返回；清理自建测试项目用） */
let projectsRoot = ''
/** /api/history 是否可用（T7.4 未落地时服务端 404） */
let historyAvailable = false

try {
  const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) })
  const json = (await res.json()) as { ok?: unknown; projectsRoot?: unknown }
  if (res.status === 200 && json.ok === true) {
    serverUp = true
    if (typeof json.projectsRoot === 'string') projectsRoot = json.projectsRoot
  }
} catch {
  /* 连接失败 / 超时 → 服务不可达 */
}
if (serverUp) {
  try {
    const res = await fetch(`${BASE_URL}/api/history`, { signal: AbortSignal.timeout(3000) })
    historyAvailable = res.status !== 404
  } catch {
    historyAvailable = false
  }
} else {
  console.log(`[e2e] 提示：${SKIP_SERVER_DOWN}`)
}

const srvSkip = serverUp ? false : SKIP_SERVER_DOWN
const historySkip = serverUp ? (historyAvailable ? false : SKIP_T74) : SKIP_SERVER_DOWN

/* ============================================================
 * 基础设施：HTTP 助手 / 项目名 / 清理
 * ============================================================ */

/** 每次运行唯一后缀（时间戳 + pid），避免重跑撞 409 重名 */
const RUN_ID = `${Date.now()}-${process.pid}`
const createdProjects = new Set<string>()

function projectName(scenario: string): string {
  return `e2e-smoke-${RUN_ID}-${scenario}`
}

interface ApiResponse {
  status: number
  json: Record<string, unknown>
}

/** 调本地服务 JSON API（10s 超时；响应体解析失败按空对象处理） */
async function api(method: string, pathname: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

/** 登记并新建测试项目（finally 前任何失败都由 after() 兜底清理） */
async function createScenarioProject(name: string, template: string): Promise<void> {
  createdProjects.add(name)
  const { status, json } = await api('POST', '/api/projects', { name, template })
  assert.equal(status, 201, `新建项目应 201：${JSON.stringify(json)}`)
  assert.equal(json.ok, true)
}

/** 删除自建测试项目目录（服务端无删项目 API，直删安全根内本测试创建的目录） */
function removeProjectDir(name: string): void {
  if (!projectsRoot) return
  fs.rmSync(path.join(projectsRoot, name), { recursive: true, force: true })
}

after(() => {
  for (const name of createdProjects) removeProjectDir(name)
  if (createdProjects.size > 0 && !projectsRoot) {
    console.log('[e2e] 警告：/api/health 未返回 projectsRoot，无法清理测试项目目录')
  }
})

/** 目录树子节点查找（GET /api/tree 的 TreeNode.children） */
interface TreeNodeLike {
  name: string
  type: 'dir' | 'file'
  children?: TreeNodeLike[]
}

function findChild(tree: TreeNodeLike, name: string): TreeNodeLike | undefined {
  return (tree.children ?? []).find((c) => c.name === name)
}

/** 等待谓词成立（解释器事件链异步驱动；超时抛错） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await sleep(20)
  }
}

/* ============================================================
 * 场景③用蓝图：event.start → flow.forLoop(0..2) → system.print(循环体)
 * （ADR-008：forLoop 一次触发跑完迭代，循环体无需回连）
 * ============================================================ */

function buildLoopBlueprint(): Record<string, unknown> {
  return {
    version: 2,
    name: 'e2e-loop',
    entry: 'bind',
    graphs: {
      bind: {
        nodes: [
          {
            id: 'n_start',
            type: 'event.start',
            params: {},
            pinDefaults: {},
            position: { x: 80, y: 200 },
            comment: 'e2e 启动入口',
          },
          {
            id: 'n_loop',
            type: 'flow.forLoop',
            params: {},
            pinDefaults: { from: 0, to: 2 },
            position: { x: 360, y: 200 },
            comment: '0..2 三次迭代（ADR-008，无需回连）',
          },
          {
            id: 'n_print',
            type: 'system.print',
            params: {},
            pinDefaults: {},
            position: { x: 660, y: 200 },
            comment: '循环体：打印索引',
          },
        ],
        edges: [
          { id: 'e1', from: { node: 'n_start', pin: 'exec' }, to: { node: 'n_loop', pin: 'exec' }, kind: 'exec' },
          { id: 'e2', from: { node: 'n_loop', pin: 'body' }, to: { node: 'n_print', pin: 'exec' }, kind: 'exec' },
          { id: 'd1', from: { node: 'n_loop', pin: 'index' }, to: { node: 'n_print', pin: 'value' }, kind: 'data' },
        ],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

/* ============================================================
 * 场景
 * ============================================================ */

test('场景① 新建项目（log-analyzer 模板）：目录结构与 project.json 校验', { skip: srvSkip }, async () => {
  const name = projectName('s1')
  await createScenarioProject(name, 'log-analyzer')

  try {
    // 项目列表在列
    const list = await api('GET', '/api/projects')
    assert.equal(list.status, 200)
    const projects = list.json.projects as Array<{ path?: unknown; name?: unknown; mainUI?: unknown }>
    const created = projects.find((p) => p.path === name)
    assert.ok(created, `项目列表应包含 ${name}`)
    assert.equal(created.name, name, '模板变量 {{PROJECT_NAME}} 应已替换')
    assert.equal(created.mainUI, 'ui/main.ui.json')

    // 目录树：模板资产 + 五个标准子目录（.history 隐藏）
    const tree = await api('GET', `/api/tree?path=${encodeURIComponent(name)}`)
    assert.equal(tree.status, 200)
    const root = tree.json.tree as unknown as TreeNodeLike
    for (const dir of ['ui', 'logic', 'assets', 'plugins']) {
      assert.equal(findChild(root, dir)?.type, 'dir', `标准子目录 ${dir} 应存在`)
    }
    assert.ok(!findChild(root, '.history'), '.history 应在目录树中隐藏')
    assert.equal(findChild(root, 'project.json')?.type, 'file')
    assert.equal(findChild(root, 'ui')?.children?.some((c) => c.name === 'main.ui.json'), true, '模板 UI 资产应存在')
    assert.equal(
      findChild(root, 'logic')?.children?.some((c) => c.name === 'main.bp.json'),
      true,
      '模板蓝图资产应存在',
    )
    assert.equal(
      findChild(root, 'assets')?.children?.some((c) => c.name === 'sample.log'),
      true,
      '模板示例日志应存在',
    )

    // project.json 内容：模板变量替换 + 元数据
    const pf = await api('GET', `/api/file?path=${encodeURIComponent(`${name}/project.json`)}`)
    assert.equal(pf.status, 200)
    assert.equal(pf.json.ok, true)
    const projectJson = JSON.parse(pf.json.content as string) as Record<string, unknown>
    assert.equal(projectJson.name, name)
    assert.equal(projectJson.mainUI, 'ui/main.ui.json')
    assert.equal(projectJson.engineVersion, '3.0.0')
    assert.deepEqual(projectJson.plugins, {})
  } finally {
    removeProjectDir(name)
  }
})

test('场景② 写 UI 资产（PUT /api/file）→ 读回一致', { skip: srvSkip }, async () => {
  const name = projectName('s2')
  await createScenarioProject(name, 'empty')

  try {
    // 覆写模板 main.ui.json：日志查看器主界面（vbox + 标题 + 列表）
    const uiJson = JSON.stringify(
      {
        version: 2,
        name: 'main',
        root: {
          id: 'ui_root',
          name: 'root',
          type: 'vbox',
          transform: { position: { x: 0, y: 0 }, size: { w: 960, h: 640 }, rotation: 0 },
          theme: { padding: 8 },
          props: { spacing: 4 },
          children: [
            {
              id: 'ui_title',
              name: 'title',
              type: 'label',
              transform: { position: { x: 0, y: 0 }, size: { w: 944, h: 32 }, rotation: 0 },
              theme: {},
              props: { text: '手机日志查看器' },
              children: [],
            },
            {
              id: 'ui_list',
              name: 'list',
              type: 'list',
              transform: { position: { x: 0, y: 0 }, size: { w: 944, h: 560 }, rotation: 0 },
              theme: {},
              props: {},
              children: [],
            },
          ],
        },
      },
      null,
      2,
    )
    const put = await api('PUT', '/api/file', { path: `${name}/ui/main.ui.json`, content: uiJson })
    assert.equal(put.status, 200)
    assert.equal(put.json.ok, true, 'PUT 成功响应须带 ok:true（编辑器各保存/新建流程按 json.ok 判定成败）')
    assert.equal(put.json.path, `${name}/ui/main.ui.json`)
    assert.equal(put.json.size, Buffer.byteLength(uiJson, 'utf8'))

    // 读回逐字节一致（utf8 文本不走 base64）
    const back = await api('GET', `/api/file?path=${encodeURIComponent(`${name}/ui/main.ui.json`)}`)
    assert.equal(back.status, 200)
    assert.equal(back.json.encoding, 'utf8')
    assert.equal(back.json.content, uiJson, 'UI 资产写读应逐字节一致')

    // 新子路径写入：父目录不存在时自动创建
    const nested = await api('PUT', '/api/file', {
      path: `${name}/ui/panels/log-panel.ui.json`,
      content: '{"version":2,"name":"log-panel"}',
    })
    assert.equal(nested.status, 200)
    const nestedBack = await api('GET', `/api/file?path=${encodeURIComponent(`${name}/ui/panels/log-panel.ui.json`)}`)
    assert.equal(nestedBack.json.content, '{"version":2,"name":"log-panel"}')
  } finally {
    removeProjectDir(name)
  }
})

test('场景③ 写蓝图资产（forLoop 0..2 + print 循环体，ADR-008）→ JSON 往返无损 + 解释器观察 0,1,2', { skip: srvSkip }, async () => {
  const name = projectName('s3')
  await createScenarioProject(name, 'empty')

  try {
    const bpJson = JSON.stringify(buildLoopBlueprint(), null, 2)

    // 经服务端写盘 + 读回：逐字节一致
    const put = await api('PUT', '/api/file', { path: `${name}/logic/main.bp.json`, content: bpJson })
    assert.equal(put.status, 200)
    const back = await api('GET', `/api/file?path=${encodeURIComponent(`${name}/logic/main.bp.json`)}`)
    assert.equal(back.json.content, bpJson, '蓝图资产写读应逐字节一致')

    // JSON 往返：deserializeIR → serializeIR → deserializeIR 无损
    const asset = deserializeIR(back.json.content as string)
    const again = deserializeIR(serializeIR(asset))
    assert.deepEqual(again, asset, 'serializeIR/deserializeIR 应往返无损')

    // ADR-008 结构位：forLoop pinDefaults from=0 to=2；循环体 exec 链不经回连
    const bind = asset.graphs['bind']
    const loop = bind.nodes.find((n) => n.id === 'n_loop')
    assert.ok(loop, 'forLoop 节点应存在')
    assert.equal(loop.type, 'flow.forLoop')
    assert.equal(loop.pinDefaults['from'], 0)
    assert.equal(loop.pinDefaults['to'], 2)
    const bodyEdge = bind.edges.find((e) => e.from.node === 'n_loop' && e.from.pin === 'body')
    assert.ok(bodyEdge, 'forLoop.body → 循环体 exec 边应存在')

    // 保存校验：无 error 级问题（保存链路 = validateIR）
    const errors = validateIR(asset, builtinSpecMap).filter((i) => i.severity === 'error')
    assert.deepEqual(errors, [])

    // 解释器执行（ADR-008 语义）：forLoop 一次触发跑完 0..2，print 依次输出 0,1,2
    const prints: unknown[] = []
    const runtimeErrors: string[] = []
    const rt = createRuntime(asset, builtinSpecMap, {
      onPrint: (...parts: unknown[]) => prints.push(...parts),
      onError: (err: Error) => runtimeErrors.push(err.message),
    })
    rt.start()
    try {
      await waitFor(() => prints.length >= 3 || runtimeErrors.length > 0, 5000, 'forLoop 循环体 print 输出')
    } finally {
      rt.stop()
    }
    assert.deepEqual(runtimeErrors, [])
    assert.deepEqual(prints, [0, 1, 2], 'forLoop 0..2 应驱动 print 输出 0,1,2（无需循环体回连）')
  } finally {
    removeProjectDir(name)
  }
})

test('场景④ /api/transpile：合法脚本 ok:true；语法错误返回行列诊断', { skip: srvSkip }, async () => {
  const name = projectName('s4')
  await createScenarioProject(name, 'empty')

  try {
    // 合法脚本：ok:true + 产物 js
    const good = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
    const ok = await api('POST', '/api/transpile', { path: `${name}/logic/util.ts`, content: good })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.match(ok.json.js as string, /add/)

    // 语法错误：ok:false + errors[{line,column,message}]（行列 1 起）
    const bad = await api('POST', '/api/transpile', { path: `${name}/logic/bad.ts`, content: 'const x: number = = 1\n' })
    assert.equal(bad.status, 200, '语法错误返回 200 + ok:false（非 4xx）')
    assert.equal(bad.json.ok, false)
    const errors = bad.json.errors as Array<{ line?: unknown; column?: unknown; message?: unknown }>
    assert.ok(Array.isArray(errors) && errors.length > 0, '应返回诊断列表')
    assert.equal(typeof errors[0].line, 'number', '诊断应带行号')
    assert.equal(typeof errors[0].column, 'number', '诊断应带列号')
    assert.ok((errors[0].line as number) >= 1 && (errors[0].column as number) >= 1, '行列号应 1 起')
    assert.ok(String(errors[0].message).length > 0, '诊断应带错误说明')
    assert.equal(typeof bad.json.message, 'string', '应返回失败摘要')
  } finally {
    removeProjectDir(name)
  }
})

test('场景⑤ /api/plugins：内置清单 phone-log / feishu-cli 在列', { skip: srvSkip }, async () => {
  const { status, json } = await api('GET', '/api/plugins')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  const manifests = json.manifests as Array<{ id?: unknown }>
  assert.ok(Array.isArray(manifests), 'manifests 应为数组')
  const ids = manifests.map((m) => String(m.id))
  assert.ok(ids.includes('phone-log'), `内置插件 phone-log 应在列（实际：${ids.join(', ')}）`)
  assert.ok(ids.includes('feishu-cli'), `内置插件 feishu-cli 应在列（实际：${ids.join(', ')}）`)
})

test('场景⑥ 保存前快照 /api/history（依赖 T7.4，未落地则跳过）', { skip: historySkip }, async () => {
  const name = projectName('s6')
  await createScenarioProject(name, 'empty')

  try {
    // 先写一个文件，模拟「保存前快照」读取路径
    await api('PUT', '/api/file', { path: `${name}/logic/main.bp.json`, content: '{}' })

    // T7.4 已落地：按服务端统一约定校验（成功 { ok: true }）；细粒度契约随 T7.4 深化
    const { status, json } = await api('GET', `/api/history?path=${encodeURIComponent(`${name}/logic/main.bp.json`)}`)
    assert.equal(status, 200)
    assert.equal(json.ok, true)
  } finally {
    removeProjectDir(name)
  }
})
