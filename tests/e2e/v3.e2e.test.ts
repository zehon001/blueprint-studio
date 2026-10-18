/**
 * v3 E2E（T13.4 最小版）：v3 UI 资产 + 资源库 API 全链路。
 *
 * 前置：npm run server 运行于 8790；不可达自动 skip。
 * 覆盖：新建项目 → 写 v3 flex UI → 读回 version3/layout → 资源库 write/list/read/export/import → 清理。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.BP_E2E_BASE ?? 'http://localhost:8790'
const SKIP = `本地服务不可达（${BASE_URL}/api/health）：启动 npm run server 后重跑`
let serverUp = false
let projectsRoot = ''
try {
  const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) })
  const j = (await r.json()) as { ok?: boolean; projectsRoot?: string }
  serverUp = r.status === 200 && j.ok === true
  projectsRoot = typeof j.projectsRoot === 'string' ? j.projectsRoot : ''
} catch {
  serverUp = false
}
if (!serverUp) console.log(`[e2e-v3] 提示：${SKIP}`)

const RUN = `${Date.now()}-${process.pid}`
const PROJECT = `e2e-v3-${RUN}`
const LIB = `E2eV3_${RUN.replace(/[^a-zA-Z0-9]/g, '')}`
const created: string[] = []

after(() => {
  if (!projectsRoot) return
  for (const name of created) {
    try {
      fs.rmSync(path.join(projectsRoot, name), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
})

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${BASE_URL}${pathname}`, init)
  return { status: r.status, json: (await r.json()) as Record<string, unknown> }
}

function v3Ui(): string {
  return JSON.stringify({
    version: 3,
    kind: 'scene',
    name: 'main',
    styles: [],
    root: {
      id: 'root',
      name: 'root',
      type: 'vbox',
      layout: { size: { w: '100%', h: '100%' } },
      container: { direction: 'column', gap: 8 },
      transform: { position: { x: 0, y: 0 }, size: { w: 960, h: 640 }, rotation: 0 },
      theme: {},
      props: {},
      children: [
        {
          id: 'a',
          name: 'a',
          type: 'label',
          layout: { grow: 1, size: { w: 'auto', h: 32 } },
          transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
          theme: {},
          props: { text: 'v3' },
          children: [],
        },
      ],
    },
    graphs: { event: { kind: 'event', nodes: [], edges: [], comments: [] } },
    variables: [],
    events: [],
  })
}

test('v3 项目：新建 → 写 flex UI → 读回 version3/layout/container', { skip: serverUp ? false : SKIP }, async () => {
  const create = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: PROJECT, template: 'empty' }),
  })
  assert.equal(create.json.ok, true)
  created.push(PROJECT)
  const write = await api('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${PROJECT}/ui/main.ui.json`, content: v3Ui() }),
  })
  assert.equal(write.json.ok, true)
  const read = await api(`/api/file?path=${encodeURIComponent(`${PROJECT}/ui/main.ui.json`)}`)
  assert.equal(read.json.ok, true)
  const asset = JSON.parse(String(read.json.content)) as {
    version: number
    root: { layout?: { size?: { w?: unknown } }; container?: { direction?: string } }
  }
  assert.equal(asset.version, 3)
  assert.equal(asset.root.layout?.size?.w, '100%')
  assert.equal(asset.root.container?.direction, 'column')
})

test('v3 模板资产：样式表 + 元素 + UI 引用可写读', { skip: serverUp ? false : SKIP }, async () => {
  const name = `${PROJECT}-assets`
  const create = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template: 'empty' }),
  })
  assert.equal(create.json.ok, true)
  created.push(name)
  const style = JSON.stringify({ version: 1, classes: { card: { props: { text: 'x' } } } })
  const element = JSON.stringify({
    version: 3,
    kind: 'element',
    name: 'Card',
    props: [{ id: 'title', default: 'hi' }],
    root: {
      id: 'r',
      name: 'r',
      type: 'vbox',
      transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
      theme: {},
      props: {},
      children: [],
    },
  })
  for (const [file, content] of [
    ['ui/styles/app.uss.json', style],
    ['ui/elements/Card.elem.json', element],
  ] as const) {
    const w = await api('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `${name}/${file}`, content }),
    })
    assert.equal(w.json.ok, true)
  }
  const ui = JSON.parse(v3Ui()) as {
    styles: string[]
    root: { classes?: string[]; children: Array<Record<string, unknown>> }
  }
  ui.styles = ['ui/styles/app.uss.json']
  ui.root.classes = ['card']
  ui.root.children.push({
    id: 'card1',
    name: 'card1',
    type: '__element',
    element: 'ui/elements/Card.elem.json',
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [],
  })
  const w = await api('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${name}/ui/main.ui.json`, content: JSON.stringify(ui) }),
  })
  assert.equal(w.json.ok, true)
  const read = await api(`/api/file?path=${encodeURIComponent(`${name}/ui/main.ui.json`)}`)
  const back = JSON.parse(String(read.json.content)) as typeof ui
  assert.deepEqual(back.styles, ['ui/styles/app.uss.json'])
  assert.deepEqual(back.root.classes, ['card'])
  assert.equal(back.root.children[1].type, '__element')
})

test('资源库：write → list → read → export(zip) → import(skip)', { skip: serverUp ? false : SKIP }, async () => {
  const content = JSON.stringify({
    version: 3,
    kind: 'element',
    name: LIB,
    props: [],
    root: {
      id: 'r',
      name: 'r',
      type: 'vbox',
      transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
      theme: {},
      props: {},
      children: [],
    },
  })
  const write = await api('/api/library/write', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'elements', name: LIB, content }),
  })
  assert.equal(write.json.ok, true)
  try {
    const list = await api('/api/library/list?kind=elements')
    assert.ok((list.json.entries as Array<{ name: string }>).some((e) => e.name === LIB))
    const read = await api(`/api/library/read?kind=elements&name=${encodeURIComponent(LIB)}`)
    assert.equal(read.json.ok, true)
    assert.match(String(read.json.content), /"version":3/)

    const exp = await fetch(
      `${BASE_URL}/api/library/export?kind=elements&name=${encodeURIComponent(LIB)}&format=zip`,
    )
    assert.equal(exp.status, 200)
    const zip = Buffer.from(await exp.arrayBuffer())
    assert.ok(zip.length > 0)
    assert.equal(zip.subarray(0, 2).toString('utf8'), 'PK')

    const imp = await api('/api/library/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zipBase64: zip.toString('base64'), policy: 'skip' }),
    })
    assert.equal(imp.json.ok, true)
    assert.equal(imp.json.policy, 'skip')
  } finally {
    await api(`/api/library/delete?kind=elements&name=${encodeURIComponent(LIB)}`, { method: 'DELETE' })
  }
})
