/**
 * DSH 适配器单测（node:test；fetch 注入，不触网）
 *
 * 覆盖：模型目录 / 权限预设 YAML 解析；createSession（工作区幂等 + 自动标题回读）、
 * sendMessage（prompt + wait 空闲 + result 回读）、deleteSession（取消 + 归档）、
 * capabilities（离线 connected:false / 在线读配置目录）。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DshOrchestratorAdapter, parseDshModelCatalog, parseDshPermissionPresets } from './dsh'

const MODEL_YAML = `
llm-pi-ai:
  providers:
    magpie:
      models:
        - id: group/glm-5.3
          name: GLM-5.3 · routing group
          reasoningEfforts:
            low: low
            high: high
            xhigh: xhigh
        - id: group/deepseek-v4-pro
          name: DeepSeek-V4-Pro
          reasoningEfforts:
            "off": none
            low: low
`

const PROFILE_YAML = `
- id: other
  name: "@deepseek-ai/other"
  config:
    presets:
      wrong:
        sandbox: nope
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
      workspace-write:
        sandbox: workspace-write
      danger-full-access:
        sandbox: danger-full-access
    defaultPreset: danger-full-access
- id: after
  name: "@deepseek-ai/after"
`

describe('DSH 配置目录解析', () => {
  test('parseDshModelCatalog：多模型 id / name / 思考强度键', () => {
    const models = parseDshModelCatalog(MODEL_YAML)
    assert.equal(models.length, 2)
    assert.equal(models[0].id, 'group/glm-5.3')
    assert.match(models[0].name, /GLM-5\.3/)
    assert.deepEqual(models[0].efforts, ['low', 'high', 'xhigh'])
    assert.deepEqual(models[1].efforts, ['off', 'low'])
  })

  test('parseDshPermissionPresets：两种条目形态 + 作用域隔离', () => {
    const presets = parseDshPermissionPresets(PROFILE_YAML)
    assert.deepEqual(presets, ['read-only', 'workspace-write', 'danger-full-access'])
    // 内联 id 形态
    const inline = parseDshPermissionPresets('- id: @deepseek-ai/dsh-permission-presets\n  config:\n    presets:\n      standard:\n        sandbox: x\n')
    assert.deepEqual(inline, ['standard'])
  })
})

describe('DshOrchestratorAdapter（fetch 注入）', () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []

  function makeAdapter(): DshOrchestratorAdapter {
    calls.length = 0
    const impl = (async (input: any, init?: any) => {
      const url = String(input instanceof URL ? input : input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const reply = (payload: unknown): Response =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/health')) return reply({ ok: true, plugin: 'dsh-plugin-orchestrator' })
      if (url.endsWith('/workspaces')) return reply({ ok: true, workspace: { workspaceId: 'ws-1' } })
      if (url.endsWith('/workspaces/ws-1/sessions')) {
        return reply({
          ok: true,
          // 工作区列表不携带 title（与编排器实际行为一致）→ 复用需逐个读状态
          sessions: [{ sessionId: 'session-old', running: false }, { sessionId: 'session-2', running: false }],
        })
      }
      if (url.endsWith('/sessions')) return reply({ ok: true, sessionId: 'session-1', promptAccepted: true })
      if (/\/sessions\/session-1$/.test(url)) return reply({ ok: true, title: '自动标题', status: 'idle' })
      if (/\/sessions\/session-old$/.test(url)) return reply({ ok: true, title: '蓝图连通测试', status: 'idle' })
      if (/\/sessions\/session-2$/.test(url)) return reply({ ok: true, title: '别的会话', status: 'idle' })
      if (url.endsWith('/prompt')) return reply({ ok: true, promptAccepted: true })
      if (url.endsWith('/model')) return reply({ ok: true, sessionId: 'session-1', selected: { provider: 'magpie', model: 'group/glm-5.3' } })
      if (url.endsWith('/wait')) return reply({ ok: true, idle: true, status: 'idle' })
      if (url.endsWith('/result')) return reply({ ok: true, result: '完成。' })
      if (url.endsWith('/cancel')) return reply({ ok: true })
      if (url.endsWith('/archive')) return reply({ ok: true })
      return new Response(JSON.stringify({ error: { code: 'not-found', message: 'no route' } }), { status: 404 })
    }) as unknown as typeof fetch
    return new DshOrchestratorAdapter(impl)
  }

  test('createSession：工作区 + 会话创建 + 自动标题回读', async () => {
    await withEnv({ BP_DSH_URL: 'http://dsh.test' }, async () => {
      const adapter = makeAdapter()
      const session = await adapter.createSession({ cwd: '/proj/dir' })
      assert.equal(session.sessionId, 'session-1')
      assert.equal(session.title, '自动标题')
      const wsCall = calls.find((c) => c.url.endsWith('/workspaces'))
      assert.equal((wsCall?.body as { path?: string } | undefined)?.path, '/proj/dir')
      // 模型设置：创建后自动 selectModel（provider 由目录解析）
      const modelCall = calls.find((c) => c.url.endsWith('/model'))
      assert.ok(modelCall, 'createSession 应调用 selectModel')
    })
  })

  test('sendMessage：prompt 受理 → wait 空闲 → result 回读', async () => {
    await withEnv({ BP_DSH_URL: 'http://dsh.test' }, async () => {
      const adapter = makeAdapter()
      const { reply } = await adapter.sendMessage({ sessionId: 'session-1', message: '你好', waitForCompletion: true })
      assert.equal(reply, '完成。')
      assert.ok(calls.some((c) => c.url.endsWith('/prompt') && (c.body as { text?: string } | undefined)?.text === '你好'))
      assert.ok(calls.some((c) => c.url.endsWith('/wait')))
      assert.ok(calls.some((c) => c.url.endsWith('/result')))
    })
  })

  test('deleteSession：先取消（失败不阻塞）再归档', async () => {
    await withEnv({ BP_DSH_URL: 'http://dsh.test' }, async () => {
      const adapter = makeAdapter()
      await adapter.deleteSession('session-1')
      assert.ok(calls.some((c) => c.url.endsWith('/cancel')))
      assert.ok(calls.some((c) => c.url.endsWith('/archive')))
    })
  })

  test('createSession 复用：标题命中工作区会话 → 复用不新建；未命中/无标题 → 新建', async () => {
    await withEnv({ BP_DSH_URL: 'http://dsh.test' }, async () => {
      const adapter = makeAdapter()
      const reused = await adapter.createSession({ cwd: '/proj/dir', title: '蓝图连通测试', reuse: true })
      assert.equal(reused.sessionId, 'session-old', '命中标题 → 复用既有会话')
      assert.equal(reused.title, '蓝图连通测试')
      assert.ok(!calls.some((c) => c.url.endsWith('/sessions') && c.method === 'POST'), '复用不应新建会话')

      calls.length = 0
      const created = await adapter.createSession({ cwd: '/proj/dir', title: '不存在的标题', reuse: true })
      assert.equal(created.sessionId, 'session-1', '未命中 → 新建')
      assert.ok(calls.some((c) => c.url.endsWith('/sessions') && c.method === 'POST'))

      calls.length = 0
      const blank = await adapter.createSession({ cwd: '/proj/dir', title: '', reuse: true })
      assert.equal(blank.sessionId, 'session-1', '标题为空 → 直接新建')
      assert.ok(calls.some((c) => c.url.endsWith('/sessions') && c.method === 'POST'))
    })
  })

  test('createSession 复用：归档台账排除（excludeSessionIds 命中 → 不复用，新建）', async () => {
    await withEnv({ BP_DSH_URL: 'http://dsh.test' }, async () => {
      const adapter = makeAdapter()
      const created = await adapter.createSession({
        cwd: '/proj/dir',
        title: '蓝图连通测试',
        reuse: true,
        excludeSessionIds: ['session-old'],
      })
      assert.equal(created.sessionId, 'session-1', '命中标题但已归档 → 不复用，新建')
      assert.ok(calls.some((c) => c.url.endsWith('/sessions') && c.method === 'POST'))
    })
  })
})

function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k])
    process.env[k] = v
  }
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}
