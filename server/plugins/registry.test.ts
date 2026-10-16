/**
 * T6.1 自测 —— 插件清单校验 / 规范化 / 三源注册表（node:test）
 *
 * 运行：npx tsx --test server/plugins/registry.test.ts
 *
 * 覆盖（DoD）：
 *  - validateManifest：合法 / 缺 id / kind 非法 / 节点 id 无前缀 / 坏 detect / install 与 event 约束
 *  - normalizeManifest：缺省 description/source 补全、nodes 空数组 OK、节点 kind 缺省 action
 *  - 三源合并：同 id 优先级（项目 > 静态 > 内置）+ 不同 id 保留 + 损坏 JSON 跳过出 warning
 *    （临时目录构造三源真实文件，测完清理）
 *  - HTTP API 冒烟：直调 handlePluginsRequest（含真实内置清单加载、详情、404、项目查询、非法 project）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  handlePluginsRequest,
  isPluginNodeId,
  loadPluginRegistry,
  normalizeManifest,
  pluginNodePrefix,
  validateManifest,
} from './registry'
import { FsError } from '../fs'
import type { PluginManifest } from '../../src/ir/types'

/* ============================================================
 * 工具
 * ============================================================ */

/** 建临时基目录跑一个用例，结束后清理（三源目录都建在其下） */
async function withBase(fn: (base: string) => void | Promise<void>): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-plugins-'))
  try {
    await fn(base)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

/** 写 JSON 文件（父目录自动创建） */
function writeJson(dir: string, name: string, content: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

/** 最小合法清单（节点 id 自动带规范前缀） */
function validManifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const prefix = pluginNodePrefix(id)
  return {
    id,
    name: `插件 ${id}`,
    kind: 'cli',
    description: `${id} 描述`,
    nodes: [
      {
        id: `${prefix}ping`,
        title: 'Ping',
        kind: 'action',
        inputs: [{ id: 'exec', type: 'exec' }],
        outputs: [{ id: 'exec', type: 'exec' }],
      },
    ],
    ...extra,
  }
}

/** 手工播种一个最小项目（project.json + plugins/ 目录），不依赖 templates/ */
function seedProject(root: string, name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true })
  writeJson(dir, 'project.json', { name, mainUI: 'ui/main.ui.json', engineVersion: '0.2.0', plugins: {} })
  return dir
}

/* ============================================================
 * validateManifest（中文错误）
 * ============================================================ */

describe('validateManifest', () => {
  test('合法清单（含 event 节点）通过校验', () => {
    const raw = validManifest('phone-log', {
      detect: { cmd: 'adb version', versionRegex: 'Android Debug Bridge version ([\\d.]+)' },
      install: { strategy: 'winget', args: ['Google.PlatformTools'] },
      update: { latestVersion: '35.0', source: 'registry' },
      nodes: [
        {
          id: 'phoneLog.read',
          title: '读取手机日志',
          kind: 'action',
          inputs: [
            { id: 'exec', type: 'exec' },
            { id: 'mode', type: 'string', options: [{ value: 'device', label: '手机读取' }, { value: 'file', label: '文件读取' }] },
            { id: 'files', type: 'file[]', optional: true, multi: true },
          ],
          outputs: [
            { id: 'exec', type: 'exec' },
            { id: 'rows', type: 'LogRow[]' },
            { id: 'count', type: 'int' },
          ],
        },
        {
          id: 'phoneLog.onLine',
          title: '手机日志·新行',
          kind: 'event',
          inputs: [],
          outputs: [
            { id: 'exec', type: 'exec' },
            { id: 'line', type: 'string' },
          ],
        },
      ],
    })
    const v = validateManifest(raw)
    assert.ok(v.ok, `应通过校验：${v.ok ? '' : v.errors.join('；')}`)
    if (v.ok) {
      assert.equal(v.manifest.id, 'phone-log')
      assert.equal(v.manifest.nodes.length, 2)
      assert.equal(v.manifest.detect?.cmd, 'adb version')
    }
  })

  test('缺 id 报中文错', () => {
    const raw = validManifest('x')
    delete (raw as Record<string, unknown>).id
    const v = validateManifest(raw)
    assert.ok(!v.ok)
    assert.ok(v.errors.some((e) => e.includes('id')), v.errors.join('；'))
  })

  test('kind 非法报中文错', () => {
    const v = validateManifest(validManifest('x', { kind: 'magic' }))
    assert.ok(!v.ok)
    assert.ok(v.errors.some((e) => e.includes('kind') && e.includes('cli')), v.errors.join('；'))
  })

  test('节点 id 无插件前缀报中文错', () => {
    const v = validateManifest(
      validManifest('phone-log', {
        nodes: [
          {
            id: 'other.thing',
            title: '无关节点',
            inputs: [{ id: 'exec', type: 'exec' }],
            outputs: [{ id: 'exec', type: 'exec' }],
          },
        ],
      }),
    )
    assert.ok(!v.ok)
    assert.ok(v.errors.some((e) => e.includes('前缀') && e.includes('other.thing')), v.errors.join('；'))
  })

  test('坏 detect：缺 cmd 与非法 versionRegex 各报中文错', () => {
    const v1 = validateManifest(validManifest('x', { detect: { versionRegex: '(\\d.+' } }))
    assert.ok(!v1.ok)
    assert.ok(v1.errors.some((e) => e.includes('detect.cmd')), v1.errors.join('；'))
    assert.ok(v1.errors.some((e) => e.includes('合法正则')), v1.errors.join('；'))
  })

  test('install：非法 strategy 与 custom-cmd 缺 cmd 各报中文错', () => {
    const v1 = validateManifest(validManifest('x', { install: { strategy: 'choco' } }))
    assert.ok(!v1.ok)
    assert.ok(v1.errors.some((e) => e.includes('install.strategy')), v1.errors.join('；'))
    const v2 = validateManifest(validManifest('x', { install: { strategy: 'custom-cmd' } }))
    assert.ok(!v2.ok)
    assert.ok(v2.errors.some((e) => e.includes('install.cmd')), v2.errors.join('；'))
  })

  test('event 节点约束：不允许 exec 输入、必须有 exec 输出', () => {
    const v1 = validateManifest(
      validManifest('x', {
        nodes: [
          {
            id: 'x.onLine',
            title: '新行',
            kind: 'event',
            inputs: [{ id: 'exec', type: 'exec' }],
            outputs: [
              { id: 'exec', type: 'exec' },
              { id: 'line', type: 'string' },
            ],
          },
        ],
      }),
    )
    assert.ok(!v1.ok)
    assert.ok(v1.errors.some((e) => e.includes('event') && e.includes('exec 输入引脚')), v1.errors.join('；'))

    const v2 = validateManifest(
      validManifest('x', {
        nodes: [{ id: 'x.onLine', title: '新行', kind: 'event', inputs: [], outputs: [{ id: 'line', type: 'string' }] }],
      }),
    )
    assert.ok(!v2.ok)
    assert.ok(v2.errors.some((e) => e.includes('event') && e.includes('exec 输出引脚')), v2.errors.join('；'))
  })

  test('nodes 非数组与引脚缺 type 报中文错（ADR-004 规范化：type 必填）', () => {
    const v1 = validateManifest(validManifest('x', { nodes: 'not-array' }))
    assert.ok(!v1.ok)
    assert.ok(v1.errors.some((e) => e.includes('nodes')), v1.errors.join('；'))
    const v2 = validateManifest(
      validManifest('x', {
        nodes: [{ id: 'x.ping', title: 'Ping', inputs: [{ id: 'a' }], outputs: [{ id: 'exec', type: 'exec' }] }],
      }),
    )
    assert.ok(!v2.ok)
    assert.ok(v2.errors.some((e) => e.includes('type')), v2.errors.join('；'))
  })
})

/* ============================================================
 * normalizeManifest（缺省补全）
 * ============================================================ */

describe('normalizeManifest', () => {
  test('缺省 description / 节点 kind / source 补全，且不修改入参', () => {
    const input = {
      id: 'my-plugin',
      name: '我的插件',
      kind: 'custom',
      nodes: [
        {
          id: 'myPlugin.ping',
          title: 'Ping',
          inputs: [{ id: 'exec', type: 'exec' }],
          outputs: [{ id: 'exec', type: 'exec' }],
        },
      ],
    } as unknown as PluginManifest
    const out = normalizeManifest(input, 'project')
    assert.equal(out.description, '')
    assert.equal(out.source, 'project')
    assert.equal(out.nodes[0].kind, 'action')
    // 不修改入参
    assert.equal(input.description, undefined)
    assert.equal((input.nodes[0] as PluginManifest['nodes'][number]).kind, undefined)
  })

  test('nodes 空数组 OK（无节点清单仅用于检测/安装）', () => {
    const out = normalizeManifest({
      id: 'bare',
      name: '裸插件',
      kind: 'cli',
      description: '无节点',
      nodes: [],
    })
    assert.deepEqual(out.nodes, [])
  })
})

describe('pluginNodePrefix / isPluginNodeId', () => {
  test('kebab → camel 前缀映射，兼容字面 id 前缀', () => {
    assert.equal(pluginNodePrefix('phone-log'), 'phoneLog.')
    assert.equal(pluginNodePrefix('feishu-cli'), 'feishuCli.')
    assert.ok(isPluginNodeId('phone-log', 'phoneLog.read'))
    assert.ok(isPluginNodeId('phone-log', 'phone-log.read')) // 字面写法兼容
    assert.ok(!isPluginNodeId('phone-log', 'other.thing'))
  })
})

/* ============================================================
 * 三源合并（临时目录真实文件）
 * ============================================================ */

describe('三源注册表 loadPluginRegistry', () => {
  /** 搭一个三源环境：builtin: phone-log/b-only；static: phone-log/c-only；project: phone-log/d-only */
  function setup(base: string): { builtinDir: string; staticDir: string; projectsRoot: string } {
    const builtinDir = path.join(base, 'builtin')
    const staticDir = path.join(base, 'static')
    const projectsRoot = path.join(base, 'root')
    writeJson(builtinDir, 'a.json', validManifest('phone-log', { description: '内置版 phone-log' }))
    writeJson(builtinDir, 'b.json', validManifest('b-only', { description: '内置独有 b' }))
    writeJson(staticDir, 'a.json', validManifest('phone-log', { description: '静态目录版 phone-log' }))
    writeJson(staticDir, 'c.json', validManifest('c-only', { description: '静态独有 c' }))
    const projectDir = seedProject(projectsRoot, 'MyTool')
    writeJson(path.join(projectDir, 'plugins'), 'a.json', validManifest('phone-log', { description: '项目覆盖版 phone-log' }))
    writeJson(path.join(projectDir, 'plugins'), 'd.json', validManifest('d-only', { description: '项目独有 d' }))
    return { builtinDir, staticDir, projectsRoot }
  }

  test('同 id 按优先级覆盖（项目 > 静态 > 内置），不同 id 全保留且 source 正确', async () => {
    await withBase(async (base) => {
      const { builtinDir, staticDir, projectsRoot } = setup(base)
      const result = await loadPluginRegistry({ projectsRoot, projectPath: 'MyTool', builtinDir, staticDir })
      assert.deepEqual(result.warnings, [], `不应有告警：${result.warnings.join('；')}`)
      const ids = result.manifests.map((m) => m.id).sort()
      assert.deepEqual(ids, ['b-only', 'c-only', 'd-only', 'phone-log'])
      const phoneLog = result.manifests.find((m) => m.id === 'phone-log')
      assert.equal(phoneLog?.source, 'project')
      assert.equal(phoneLog?.description, '项目覆盖版 phone-log')
      assert.equal(result.manifests.find((m) => m.id === 'b-only')?.source, 'builtin')
      assert.equal(result.manifests.find((m) => m.id === 'c-only')?.source, 'static')
      assert.equal(result.manifests.find((m) => m.id === 'd-only')?.source, 'project')
      assert.equal(result.sources.builtin, builtinDir)
      assert.equal(result.sources.static, staticDir)
      assert.ok(result.sources.project && fs.existsSync(result.sources.project))
    })
  })

  test('不传 project = 只列内置 + 静态（静态优先于内置）', async () => {
    await withBase(async (base) => {
      const { builtinDir, staticDir, projectsRoot } = setup(base)
      const result = await loadPluginRegistry({ projectsRoot, builtinDir, staticDir })
      const ids = result.manifests.map((m) => m.id).sort()
      assert.deepEqual(ids, ['b-only', 'c-only', 'phone-log'])
      assert.equal(result.manifests.find((m) => m.id === 'phone-log')?.source, 'static')
      assert.equal(result.manifests.find((m) => m.id === 'phone-log')?.description, '静态目录版 phone-log')
      assert.equal(result.sources.project, undefined)
    })
  })

  test('损坏 JSON / 校验失败单文件跳过并产生 warning，不炸注册表', async () => {
    await withBase(async (base) => {
      const { builtinDir, staticDir, projectsRoot } = setup(base)
      writeJson(builtinDir, 'broken.json', '{ 这不是合法 JSON') // 解析失败
      writeJson(staticDir, 'badschema.json', { name: '缺 id 的清单' }) // 校验失败
      const result = await loadPluginRegistry({ projectsRoot, projectPath: 'MyTool', builtinDir, staticDir })
      assert.ok(result.warnings.some((w) => w.includes('broken.json') && w.includes('解析失败')), result.warnings.join('；'))
      assert.ok(result.warnings.some((w) => w.includes('badschema.json') && w.includes('校验失败')), result.warnings.join('；'))
      // 其余清单不受影响
      assert.deepEqual(
        result.manifests.map((m) => m.id).sort(),
        ['b-only', 'c-only', 'd-only', 'phone-log'],
      )
    })
  })

  test('同源重复 id：保留文件名靠前者并告警', async () => {
    await withBase(async (base) => {
      const builtinDir = path.join(base, 'builtin')
      const projectsRoot = path.join(base, 'root')
      writeJson(builtinDir, 'a.json', validManifest('dup', { description: 'first' }))
      writeJson(builtinDir, 'z.json', validManifest('dup', { description: 'second' }))
      const result = await loadPluginRegistry({ projectsRoot, builtinDir })
      assert.equal(result.manifests.length, 1)
      assert.equal(result.manifests[0].description, 'first')
      assert.ok(result.warnings.some((w) => w.includes('重复插件 id') && w.includes('z.json')), result.warnings.join('；'))
    })
  })

  test('project 非法（越权 / 非有效项目）抛 FsError', async () => {
    await withBase(async (base) => {
      const { builtinDir, staticDir, projectsRoot } = setup(base)
      await assert.rejects(
        loadPluginRegistry({ projectsRoot, projectPath: '../escape', builtinDir, staticDir }),
        (e: unknown) => e instanceof FsError && e.status === 403,
      )
      await assert.rejects(
        loadPluginRegistry({ projectsRoot, projectPath: 'NoSuchProject', builtinDir, staticDir }),
        (e: unknown) => e instanceof FsError && e.status === 404,
      )
    })
  })
})

/* ============================================================
 * HTTP API 冒烟（直调 handlePluginsRequest；含真实内置清单）
 * ============================================================ */

describe('HTTP API handlePluginsRequest', () => {
  test('GET /api/plugins：真实内置清单可列出（phone-log / feishu-cli，source=builtin）', async () => {
    await withBase(async (base) => {
      const res = await handlePluginsRequest('GET', '/api/plugins', new URLSearchParams(), base)
      assert.ok(res)
      assert.equal(res.status, 200)
      const payload = res.payload as { ok: boolean; manifests: PluginManifest[]; warnings: string[] }
      assert.equal(payload.ok, true)
      assert.ok(Array.isArray(payload.warnings))
      const ids = payload.manifests.map((m) => m.id)
      assert.ok(ids.includes('phone-log'), `应含 phone-log：${ids.join(',')}`)
      assert.ok(ids.includes('feishu-cli'), `应含 feishu-cli：${ids.join(',')}`)
      for (const m of payload.manifests) assert.equal(m.source, 'builtin')
     })
  })

  test('GET /api/plugins/:id：单清单详情含节点；未知 id 404；畸形编码 400', async () => {
    await withBase(async (base) => {
      const ok = await handlePluginsRequest('GET', '/api/plugins/phone-log', new URLSearchParams(), base)
      assert.ok(ok)
      assert.equal(ok.status, 200)
      const manifest = (ok.payload as { ok: boolean; manifest: PluginManifest }).manifest
      assert.equal(manifest.id, 'phone-log')
      const nodeIds = manifest.nodes.map((n) => n.id)
      assert.ok(nodeIds.includes('phoneLog.read'))
      assert.ok(nodeIds.includes('phoneLog.onLine'))

      const miss = await handlePluginsRequest('GET', '/api/plugins/nope', new URLSearchParams(), base)
      assert.ok(miss)
      assert.equal(miss.status, 404)
      assert.equal((miss.payload as { ok: boolean; message: string }).ok, false)
      assert.ok((miss.payload as { message: string }).message.includes('插件不存在'))

      const bad = await handlePluginsRequest('GET', '/api/plugins/%zz', new URLSearchParams(), base)
      assert.ok(bad)
      assert.equal(bad.status, 400)
    })
  })

  test('GET /api/plugins?project=：项目级清单覆盖内置（全链路）', async () => {
    await withBase(async (base) => {
      const projectsRoot = path.join(base, 'root')
      const projectDir = seedProject(projectsRoot, 'MyTool')
      writeJson(path.join(projectDir, 'plugins'), 'phone-log.json', validManifest('phone-log', { name: '项目覆盖版手机日志' }))
      const query = new URLSearchParams('project=MyTool')
      const list = await handlePluginsRequest('GET', '/api/plugins', query, projectsRoot)
      assert.ok(list)
      const phoneLog = (list.payload as { manifests: PluginManifest[] }).manifests.find((m) => m.id === 'phone-log')
      assert.equal(phoneLog?.source, 'project')
      assert.equal(phoneLog?.name, '项目覆盖版手机日志')
      const detail = await handlePluginsRequest('GET', '/api/plugins/phone-log', query, projectsRoot)
      assert.ok(detail)
      assert.equal((detail.payload as { manifest: PluginManifest }).manifest.name, '项目覆盖版手机日志')
    })
  })

  test('project 指向不存在的项目 → FsError 404；非 GET / 非 /api/plugins 路由返回 null', async () => {
    await withBase(async (base) => {
      await assert.rejects(
        handlePluginsRequest('GET', '/api/plugins', new URLSearchParams('project=NoSuch'), base),
        (e: unknown) => e instanceof FsError && e.status === 404,
      )
      assert.equal(await handlePluginsRequest('POST', '/api/plugins', new URLSearchParams(), base), null)
      assert.equal(await handlePluginsRequest('GET', '/api/health', new URLSearchParams(), base), null)
      assert.equal(await handlePluginsRequest('GET', '/api/plugins/', new URLSearchParams(), base), null)
    })
  })
})
