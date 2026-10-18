/**
 * T0.2 自测 —— 项目 FS API（node:test）
 *
 * 运行：npx tsx --test server/fs.test.ts
 *
 * 重点覆盖（DoD 硬性）：
 *  - 路径安全：越权路径样本 ≥5 种（.. 上跳 / 绝对路径 / 盘符 / UNC / Unix 绝对路径 /
 *    混合分隔符上跳 / NUL / 符号链接逃逸）
 *  - 模板脚手架：新建项目目录结构符合 PLAN §4.1、模板变量替换
 *  - CRUD / move / tree / import / watch 全链路
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ENGINE_VERSION,
  FsError,
  createProject,
  deletePathSafe,
  importIntoProject,
  importProjectFolder,
  isPathWithin,
  listProjects,
  movePath,
  readFileSafe,
  readTree,
  resolveSafePath,
  watchPath,
  writeFileSafe,
} from './fs'

/* ============================================================
 * 工具
 * ============================================================ */

/** 建临时安全根跑一个用例，结束后清理 */
function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-fs-'))
  try {
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function withRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-fs-'))
  try {
    await fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function expectFsError(fn: () => unknown, status: number, label: string): void {
  try {
    fn()
    assert.fail(`应当被拒绝（${label}）`)
  } catch (e) {
    assert.ok(e instanceof FsError, `${label}: 应抛 FsError，实际 ${String(e)}`)
    assert.equal((e as FsError).status, status, label)
  }
}

/** 轮询等待条件成立（监视类测试用，超时抛错） */
async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 在安全根内建一个 empty 模板项目，返回项目目录绝对路径 */
function seed(root: string, name = 'Proj'): string {
  createProject(root, name, 'empty')
  return path.join(root, name)
}

/* ============================================================
 * 路径安全（DoD 硬性：越权路径被拒）
 * ============================================================ */

describe('路径安全', () => {
  /** [样本, 期望状态码] —— 覆盖 8 种越权形态（≥ DoD 要求的 5 种） */
  const ILLEGAL: Array<[string, number]> = [
    ['../escape.txt', 403], // 直接上跳
    ['proj/../../escape.txt', 403], // 穿项目上跳
    ['a/b/../../../escape.txt', 403], // 深层上跳
    ['C:/Windows/System32/config', 403], // 盘符绝对路径
    ['c:\\Windows\\notepad.exe', 403], // 盘符 + 反斜杠
    ['\\\\server\\share\\secret.txt', 403], // UNC
    ['/etc/passwd', 403], // Unix 绝对路径
    ['proj/\0.txt', 400], // NUL 注入
  ]

  test('越权路径样本全部被拒', () => {
    withRoot((root) => {
      for (const [p, status] of ILLEGAL) {
        expectFsError(() => resolveSafePath(root, p), status, `样本 ${JSON.stringify(p)}`)
        // CRUD 入口同样拒绝（以 file 读为例）
        if (status === 403) expectFsError(() => readFileSafe(root, p), status, `file 读 ${JSON.stringify(p)}`)
      }
    })
  })

  test('合法相对路径解析在安全根内', () => {
    withRoot((root) => {
      const abs = resolveSafePath(root, 'MyTool/ui/main.ui.json')
      assert.ok(isPathWithin(root, abs))
      assert.equal(path.relative(root, abs).split(path.sep).join('/'), 'MyTool/ui/main.ui.json')
    })
  })

  test('名字内含连续点不算上跳', () => {
    withRoot((root) => {
      const abs = resolveSafePath(root, 'proj/a..b/c..d.txt')
      assert.ok(isPathWithin(root, abs))
    })
  })

  test('Windows 路径大小写不敏感', () => {
    if (process.platform !== 'win32') return
    withRoot((root) => {
      fs.mkdirSync(path.join(root, 'MyTool', 'ui'), { recursive: true })
      const abs = resolveSafePath(root, 'mytool/UI/main.ui.json')
      const expected = path.join(root, 'MyTool', 'ui', 'main.ui.json')
      assert.equal(abs.toLowerCase(), expected.toLowerCase())
    })
  })

  test('符号链接逃逸被拒（仅非 Windows）', () => {
    if (process.platform === 'win32') return
    withRoot((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-out-'))
      try {
        fs.mkdirSync(path.join(root, 'proj'))
        fs.symlinkSync(outside, path.join(root, 'proj', 'link'), 'dir')
        expectFsError(() => resolveSafePath(root, 'proj/link/x.txt'), 403, 'symlink 逃逸')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})

/* ============================================================
 * 模板脚手架（DoD：新建项目 → 目录结构符合 PLAN §4.1）
 * ============================================================ */

describe('模板与项目', () => {
  test('empty 模板：目录结构符合 PLAN §4.1 + 变量替换', () => {
    withRoot((root) => {
      const created = createProject(root, '我的工具', 'empty')
      assert.equal(created.name, '我的工具')
      assert.equal(created.path, '我的工具')
      assert.equal(created.mainUI, 'ui/main.ui.json')
      for (const dir of ['ui', 'logic', 'assets', 'plugins', '.history']) {
        assert.ok(fs.statSync(path.join(root, '我的工具', dir)).isDirectory(), `缺少目录 ${dir}`)
      }
      const pf = JSON.parse(fs.readFileSync(path.join(root, '我的工具', 'project.json'), 'utf8')) as Record<string, unknown>
      assert.equal(pf.name, '我的工具')
      assert.equal(pf.mainUI, 'ui/main.ui.json')
      assert.equal(pf.engineVersion, ENGINE_VERSION)
      assert.ok(!JSON.stringify(pf).includes('{{'), '模板变量未替换')
      const ui = JSON.parse(fs.readFileSync(path.join(root, '我的工具', 'ui', 'main.ui.json'), 'utf8')) as {
        version: number
        root: { type: string }
      }
      assert.equal(ui.version, 3)
      assert.equal(ui.root.type, 'vbox')
    })
  })

  test('log-analyzer 模板：UI 骨架 + 合法 IR + sample.log', () => {
    withRoot((root) => {
      createProject(root, '日志分析器', 'log-analyzer')
      const p = path.join(root, '日志分析器')
      const ui = JSON.parse(fs.readFileSync(path.join(p, 'ui', 'main.ui.json'), 'utf8')) as {
        version: number
        root: { type: string; children: Array<{ name: string; type: string; logicAsset?: string; events?: string[] }> }
        graphs?: Record<string, { nodes: Array<{ type: string }>; edges: unknown[] }>
      }
      assert.equal(ui.version, 3)
      assert.equal(ui.root.type, 'vbox')
      assert.equal(ui.root.children.length, 2)
      assert.equal(ui.root.children[0].type, 'label')
      const list = ui.root.children[1]
      assert.equal(list.type, 'list')
      // v3：逻辑内嵌（不再引用 logicAsset）；事件图随 UI 资产
      assert.equal(list.logicAsset, undefined)
      assert.ok(ui.graphs?.event, 'v3 模板应内嵌事件图')
      assert.equal(ui.graphs.event.nodes[0].type, 'event.start')

      const ir = JSON.parse(fs.readFileSync(path.join(p, 'logic', 'main.bp.json'), 'utf8')) as {
        version: number
        entry: string
        graphs: Record<string, { nodes: Array<{ type: string }>; edges: unknown[] }>
        variables: unknown[]
      }
      assert.equal(ir.version, 2)
      assert.equal(ir.entry, 'bind')
      assert.equal(ir.graphs.bind.nodes[0].type, 'event.start')
      // T7.2 前置补全：开箱可跑（读文件 → 解析 → 填列表 → 打印），5 节点 5 边
      const nodeTypes = ir.graphs.bind.nodes.map((n) => n.type)
      assert.ok(nodeTypes.includes('system.readFile'), '模板应含读文件节点')
      assert.ok(nodeTypes.includes('convert.androidLogParse'), '模板应含日志解析节点')
      assert.ok(nodeTypes.includes('ui.listSetItems'), '模板应含列表填充节点')
      assert.equal(ir.graphs.bind.edges.length, 5)
      assert.ok(Array.isArray(ir.variables))

      const lines = fs.readFileSync(path.join(p, 'assets', 'sample.log'), 'utf8').trim().split(/\r?\n/)
      assert.equal(lines.length, 10)
      const re = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [DIWEV]\/[A-Za-z.]+\(\d+\): .+$/
      for (const line of lines) assert.ok(re.test(line), `日志格式不符：${line}`)
    })
  })

  test('非法项目名被拒（400）', () => {
    withRoot((root) => {
      for (const name of ['../evil', 'a/b', 'a\\b', 'con', 'a<b', 'a:b', '', '   ']) {
        expectFsError(() => createProject(root, name, 'empty'), 400, `项目名 ${JSON.stringify(name)}`)
      }
      expectFsError(() => createProject(root, 42, 'empty'), 400, '项目名非字符串')
    })
  })

  test('项目名规范化：结尾点/空格被去除（Windows 语义）', () => {
    withRoot((root) => {
      createProject(root, 'name.', 'empty')
      createProject(root, 'Tool ', 'empty')
      assert.ok(fs.existsSync(path.join(root, 'name', 'project.json')))
      assert.ok(fs.existsSync(path.join(root, 'Tool', 'project.json')))
    })
  })

  test('重名与未知模板被拒', () => {
    withRoot((root) => {
      createProject(root, 'Demo', 'empty')
      expectFsError(() => createProject(root, 'Demo', 'empty'), 409, '重名')
      expectFsError(() => createProject(root, 'demo', 'empty'), 409, '大小写变体重名')
      expectFsError(() => createProject(root, 'X', 'nope'), 400, '未知模板')

      // 项目名大小写在目录树中表现为同一文件夹（project.json.name 为显示名）
      assert.equal(listProjects(root).length, 1)
    })
  })

  test('listProjects 列出项目', () => {
    withRoot((root) => {
      createProject(root, 'Alpha', 'empty')
      createProject(root, 'Beta', 'log-analyzer')
      fs.mkdirSync(path.join(root, 'NotAProject')) // 无 project.json → 不算项目
      const list = listProjects(root)
      assert.equal(list.length, 2)
      const alpha = list.find((p) => p.path === 'Alpha')
      assert.ok(alpha)
      assert.equal(alpha.mainUI, 'ui/main.ui.json')
      assert.equal(alpha.engineVersion, ENGINE_VERSION)
      assert.ok(alpha.mtime)
      assert.equal(list.find((p) => p.path === 'NotAProject'), undefined)
    })
  })
})

/* ============================================================
 * 文件 CRUD
 * ============================================================ */

describe('文件 CRUD', () => {
  test('写入 / 读取 / 覆盖（utf8 往返）', () => {
    withRoot((root) => {
      seed(root)
      const w = writeFileSafe(root, 'Proj/logic/notes.txt', '你好 hello')
      assert.equal(w.path, 'Proj/logic/notes.txt')
      assert.ok(w.size > 0)
      const r = readFileSafe(root, 'Proj/logic/notes.txt')
      assert.equal(r.encoding, 'utf8')
      assert.equal(r.content, '你好 hello')
      writeFileSafe(root, 'Proj/logic/notes.txt', 'v2')
      assert.equal(readFileSafe(root, 'Proj/logic/notes.txt').content, 'v2')
    })
  })

  test('写文件自动建父目录（多层）', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/logic/sub/deep/x.txt', '1')
      assert.ok(fs.existsSync(path.join(root, 'Proj', 'logic', 'sub', 'deep', 'x.txt')))
    })
  })

  test('项目外路径写入被拒（文件夹即项目）', () => {
    withRoot((root) => {
      expectFsError(() => writeFileSafe(root, 'loose/x.txt', 'a'), 404, '安全根内但非项目')
      expectFsError(() => writeFileSafe(root, '', 'a'), 400, '安全根本身')
      expectFsError(() => writeFileSafe(root, 'Proj/x.txt', 42), 400, 'content 非字符串')
    })
  })

  test('读取：不存在 404 / 目录 400 / 二进制返回 base64', () => {
    withRoot((root) => {
      seed(root)
      expectFsError(() => readFileSafe(root, 'Proj/nope.txt'), 404, '不存在')
      expectFsError(() => readFileSafe(root, 'Proj/ui'), 400, '读目录')
      const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
      fs.writeFileSync(path.join(root, 'Proj', 'assets', 'img.png'), bin)
      const r = readFileSafe(root, 'Proj/assets/img.png')
      assert.equal(r.encoding, 'base64')
      assert.equal(Buffer.from(r.content, 'base64').toString('hex'), bin.toString('hex'))
    })
  })

  test('删除：文件 / 目录递归 / 缺失 404 / 项目根被拒', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/assets/a.txt', 'x')
      assert.equal(deletePathSafe(root, 'Proj/assets/a.txt').kind, 'file')
      expectFsError(() => readFileSafe(root, 'Proj/assets/a.txt'), 404, '删除后读取')
      fs.mkdirSync(path.join(root, 'Proj', 'assets', 'sub'), { recursive: true })
      fs.writeFileSync(path.join(root, 'Proj', 'assets', 'sub', 'b.txt'), 'y')
      assert.equal(deletePathSafe(root, 'Proj/assets/sub').kind, 'dir')
      assert.ok(!fs.existsSync(path.join(root, 'Proj', 'assets', 'sub')))
      expectFsError(() => deletePathSafe(root, 'Proj/assets/missing.txt'), 404, '删除不存在')
      expectFsError(() => deletePathSafe(root, 'Proj'), 400, '删除项目根')
      expectFsError(() => deletePathSafe(root, ''), 400, '删除安全根本身')
    })
  })
})

/* ============================================================
 * 移动 / 重命名
 * ============================================================ */

describe('move', () => {
  test('同目录重命名', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/logic/old.txt', 'data')
      const r = movePath(root, { from: 'Proj/logic/old.txt', to: 'Proj/logic/new.txt' })
      assert.equal(r.path, 'Proj/logic/new.txt')
      assert.ok(r.moved)
      assert.ok(fs.existsSync(path.join(root, 'Proj', 'logic', 'new.txt')))
      assert.ok(!fs.existsSync(path.join(root, 'Proj', 'logic', 'old.txt')))
    })
  })

  test('跨项目移动（资产共享）', () => {
    withRoot((root) => {
      seed(root, 'A')
      seed(root, 'B')
      writeFileSafe(root, 'A/assets/share.txt', 'shared')
      movePath(root, { from: 'A/assets/share.txt', to: 'B/logic/share.txt' })
      assert.ok(fs.existsSync(path.join(root, 'B', 'logic', 'share.txt')))
      assert.ok(!fs.existsSync(path.join(root, 'A', 'assets', 'share.txt')))
    })
  })

  test('目标已存在 409；overwrite 覆盖', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/a.txt', 'src')
      writeFileSafe(root, 'Proj/b.txt', 'dst')
      expectFsError(() => movePath(root, { from: 'Proj/a.txt', to: 'Proj/b.txt' }), 409, '目标存在')
      movePath(root, { from: 'Proj/a.txt', to: 'Proj/b.txt', overwrite: true })
      assert.equal(readFileSafe(root, 'Proj/b.txt').content, 'src')
    })
  })

  test('非法 move：源缺失 404 / 移入自身 400 / 非项目目标 404 / 项目根被拒', () => {
    withRoot((root) => {
      seed(root)
      fs.mkdirSync(path.join(root, 'Proj', 'ui', 'sub'), { recursive: true })
      expectFsError(() => movePath(root, { from: 'Proj/missing.txt', to: 'Proj/x.txt' }), 404, '源缺失')
      expectFsError(() => movePath(root, { from: 'Proj/ui', to: 'Proj/ui/sub/ui' }), 400, '目录移入自身')
      expectFsError(() => movePath(root, { from: 'Proj/a.txt', to: 'loose/x.txt' }), 404, '目标不在项目内')
      expectFsError(() => movePath(root, { from: 'Proj', to: 'Proj2' }), 400, '移动项目根')
      expectFsError(() => movePath(root, {}), 400, '缺参数')
    })
  })
})

/* ============================================================
 * 目录树
 * ============================================================ */

describe('tree', () => {
  test('结构正确、.history 隐藏、目录优先排序', () => {
    withRoot((root) => {
      seed(root)
      fs.mkdirSync(path.join(root, 'Proj', 'logic', 'util'), { recursive: true })
      fs.writeFileSync(path.join(root, 'Proj', 'logic', 'util', 'a.ts'), 'x')
      fs.writeFileSync(path.join(root, 'Proj', 'logic', 'z.bp.json'), '{}')
      fs.writeFileSync(path.join(root, 'Proj', '.history', 'hidden.txt'), 'x') // 手造 .history 内容
      const tree = readTree(root, 'Proj')
      assert.equal(tree.type, 'dir')
      assert.equal(tree.path, 'Proj')
      const ui = tree.children.find((n) => n.name === 'ui')
      assert.ok(ui?.children.some((n) => n.name === 'main.ui.json' && n.type === 'file' && n.ext === 'json'))
      assert.equal(tree.children.find((n) => n.name === '.history'), undefined, '.history 应隐藏')
      const logic = tree.children.find((n) => n.name === 'logic')
      assert.equal(logic?.children[0].name, 'util') // 目录排在文件前
      const file = logic?.children[1]
      assert.equal(file?.name, 'z.bp.json')
      assert.equal(file?.ext, 'json')
      assert.equal(file?.path, 'Proj/logic/z.bp.json')
    })
  })

  test('路径非法：非项目 404 / 不存在 404 / 文件路径 400', () => {
    withRoot((root) => {
      seed(root)
      expectFsError(() => readTree(root, 'Nope'), 404, '非项目')
      expectFsError(() => readTree(root, 'Proj/missing'), 404, '不存在')
      writeFileSafe(root, 'Proj/a.txt', 'x')
      expectFsError(() => readTree(root, 'Proj/a.txt'), 400, 'path 是文件')
    })
  })
})

/* ============================================================
 * 外部导入
 * ============================================================ */

describe('import', () => {
  test('导入外部文件与文件夹（源在安全根外）；冲突自动改名', () => {
    withRoot((root) => {
      seed(root)
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-ext-'))
      try {
        fs.writeFileSync(path.join(outside, 'f1.txt'), 'one')
        fs.mkdirSync(path.join(outside, 'sub'))
        fs.writeFileSync(path.join(outside, 'sub', 'f2.txt'), 'two')

        const r1 = importIntoProject(root, 'Proj/assets', path.join(outside, 'f1.txt'))
        assert.equal(r1.ok, true)
        assert.equal(r1.files, 1)
        assert.equal(r1.target, 'Proj/assets/f1.txt')
        assert.equal(r1.renamed, false)

        const r2 = importIntoProject(root, 'Proj/assets', path.join(outside, 'sub'))
        assert.equal(r2.files, 1)
        assert.equal(r2.target, 'Proj/assets/sub')
        assert.ok(fs.existsSync(path.join(root, 'Proj', 'assets', 'sub', 'f2.txt')))

        const r3 = importIntoProject(root, 'Proj/assets', path.join(outside, 'f1.txt'))
        assert.equal(r3.renamed, true)
        assert.equal(r3.target, 'Proj/assets/f1 (2).txt')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test('非法导入：目标非项目 404 / 源缺失 404 / 相对路径 400', () => {
    withRoot((root) => {
      seed(root)
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-ext-'))
      try {
        fs.writeFileSync(path.join(outside, 'x.txt'), 'x')
        expectFsError(() => importIntoProject(root, 'loose', path.join(outside, 'x.txt')), 404, '目标非项目')
        expectFsError(() => importIntoProject(root, 'Proj/assets', path.join(outside, 'nope.txt')), 404, '源缺失')
        expectFsError(() => importIntoProject(root, 'Proj/assets', 'relative/x.txt'), 400, '相对路径')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})

/* ============================================================
 * 文件监视
 * ============================================================ */

describe('watch', () => {
  test('fs.watch 模式：add / change / unlink', async () => {
    await withRootAsync(async (root) => {
      const proj = seed(root)
      const events: Array<{ type: string; path: string }> = []
      const handle = watchPath(proj, (batch) => events.push(...batch), { debounceMs: 100 })
      try {
        fs.writeFileSync(path.join(proj, 'a.txt'), '1')
        await waitFor(() => events.some((e) => e.path === 'a.txt' && (e.type === 'add' || e.type === 'change')), 5000, 'add a.txt')

        fs.writeFileSync(path.join(proj, 'a.txt'), '2')
        await waitFor(() => events.some((e) => e.path === 'a.txt' && e.type === 'change'), 5000, 'change a.txt')

        fs.rmSync(path.join(proj, 'a.txt'))
        await waitFor(() => events.some((e) => e.path === 'a.txt' && e.type === 'unlink'), 5000, 'unlink a.txt')
      } finally {
        handle.close()
      }
    })
  })

  test('子目录事件（recursive）', async () => {
    await withRootAsync(async (root) => {
      const proj = seed(root)
      const events: Array<{ type: string; path: string }> = []
      const handle = watchPath(proj, (batch) => events.push(...batch), { debounceMs: 100 })
      try {
        // empty 模板已含 logic/ 目录，直接在子目录内写文件验证 recursive 监视
        fs.writeFileSync(path.join(proj, 'logic', 'deep.txt'), 'x')
        await waitFor(
          () => events.some((e) => e.path.replace(/\\/g, '/').includes('logic/deep.txt')),
          5000,
          'recursive 事件',
        )
      } finally {
        handle.close()
      }
    })
  })

  test('轮询兜底（forcePoll）：add / unlink', async () => {
    await withRootAsync(async (root) => {
      const proj = seed(root)
      const events: Array<{ type: string; path: string }> = []
      const handle = watchPath(proj, (batch) => events.push(...batch), {
        debounceMs: 50,
        pollIntervalMs: 100,
        forcePoll: true,
      })
      try {
        fs.writeFileSync(path.join(proj, 'p.txt'), '1')
        await waitFor(() => events.some((e) => e.path === 'p.txt' && e.type === 'add'), 5000, 'poll add')
        fs.rmSync(path.join(proj, 'p.txt'))
        await waitFor(() => events.some((e) => e.path === 'p.txt' && e.type === 'unlink'), 5000, 'poll unlink')
      } finally {
        handle.close()
      }
    })
  })
})

/* ============================================================
 * 整文件夹导入为项目（T0.6 项目管理器「导入项目」）
 * ============================================================ */

describe('importProjectFolder（T0.6）', () => {
  test('导入含 project.json 的文件夹：整体复制、显示名来自 project.json、列表可见', () => {
    withRoot((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-impfull-'))
      try {
        fs.writeFileSync(
          path.join(outside, 'project.json'),
          JSON.stringify({ name: '外部项目', mainUI: 'ui/custom.ui.json', engineVersion: '0.1.0', plugins: {} }),
        )
        fs.mkdirSync(path.join(outside, 'ui'))
        fs.writeFileSync(path.join(outside, 'ui', 'custom.ui.json'), '{"version":2}')
        fs.writeFileSync(path.join(outside, 'README.md'), 'hello')

        const folderName = path.basename(outside)
        const r = importProjectFolder(root, outside)
        assert.equal(r.ok, true)
        assert.equal(r.scaffolded, false, '已含 project.json，不应补脚手架')
        assert.equal(r.renamed, false)
        assert.equal(r.project.path, folderName)
        assert.equal(r.project.name, '外部项目')
        assert.equal(r.project.mainUI, 'ui/custom.ui.json')
        assert.equal(r.files, 3)

        const dest = path.join(root, folderName)
        assert.equal(
          fs.readFileSync(path.join(dest, 'project.json'), 'utf8'),
          fs.readFileSync(path.join(outside, 'project.json'), 'utf8'),
          'project.json 应原样复制',
        )
        assert.ok(fs.existsSync(path.join(dest, 'ui', 'custom.ui.json')))
        assert.ok(fs.existsSync(path.join(dest, 'README.md')))

        const list = listProjects(root)
        assert.equal(list.length, 1)
        assert.equal(list[0].path, folderName)
        assert.equal(list[0].name, '外部项目')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test('导入空文件夹：补脚手架（标准目录 + 最小 project.json + 空 main.ui.json）', () => {
    withRoot((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-impempty-'))
      try {
        assert.equal(fs.readdirSync(outside).length, 0)
        const r = importProjectFolder(root, outside, '导入的空项目')
        assert.equal(r.ok, true)
        assert.equal(r.scaffolded, true)
        assert.equal(r.renamed, false)
        assert.equal(r.project.path, '导入的空项目')
        assert.equal(r.project.name, '导入的空项目')
        assert.equal(r.project.mainUI, 'ui/main.ui.json')

        const dest = path.join(root, '导入的空项目')
        for (const dir of ['ui', 'logic', 'assets', 'plugins', '.history']) {
          assert.ok(fs.statSync(path.join(dest, dir)).isDirectory(), `缺少目录 ${dir}`)
        }
        const pf = JSON.parse(fs.readFileSync(path.join(dest, 'project.json'), 'utf8')) as Record<string, unknown>
        assert.equal(pf.name, '导入的空项目')
        assert.equal(pf.mainUI, 'ui/main.ui.json')
        assert.equal(pf.engineVersion, ENGINE_VERSION)
        const ui = JSON.parse(fs.readFileSync(path.join(dest, 'ui', 'main.ui.json'), 'utf8')) as {
          version: number
          root: { type: string }
        }
        assert.equal(ui.version, 2)
        assert.equal(ui.root.type, 'vbox')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test('导入无 project.json 但含 ui/*.ui.json 的文件夹：mainUI 探测到第一个', () => {
    withRoot((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-impprobe-'))
      try {
        fs.mkdirSync(path.join(outside, 'ui'))
        fs.writeFileSync(path.join(outside, 'ui', 'detail.ui.json'), '{"version":2}')
        fs.writeFileSync(path.join(outside, 'ui', 'main.ui.json'), '{"version":2}')
        fs.mkdirSync(path.join(outside, 'logic'))
        fs.writeFileSync(path.join(outside, 'logic', 'helper.ts'), 'export const x = 1')

        const r = importProjectFolder(root, outside, '探测项目')
        assert.equal(r.scaffolded, true)
        assert.equal(r.project.mainUI, 'ui/detail.ui.json', '应探测 ui/*.ui.json 的第一个（COLLATOR 排序）')

        const dest = path.join(root, '探测项目')
        assert.ok(fs.existsSync(path.join(dest, 'ui', 'detail.ui.json')), '源 UI 资产应原样保留')
        assert.ok(fs.existsSync(path.join(dest, 'logic', 'helper.ts')))
        const pf = JSON.parse(fs.readFileSync(path.join(dest, 'project.json'), 'utf8')) as { mainUI: string }
        assert.equal(pf.mainUI, 'ui/detail.ui.json')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test('非法导入：文件路径 400 / 源缺失 404 / 相对路径 400 / 非法项目名 400', () => {
    withRoot((root) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-impbad-'))
      try {
        const file = path.join(outside, 'not-a-dir.txt')
        fs.writeFileSync(file, 'x')
        expectFsError(() => importProjectFolder(root, file), 400, '源是文件')
        expectFsError(() => importProjectFolder(root, path.join(outside, 'missing')), 404, '源不存在')
        expectFsError(() => importProjectFolder(root, 'relative/path'), 400, '相对路径')
        expectFsError(() => importProjectFolder(root, outside, 'a/b'), 400, 'name 含路径分隔符')
        // name 为空串时回落到源文件夹名（合法），不应抛错
        assert.equal(importProjectFolder(root, outside, '   ').ok, true)
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  test('重名自动后缀（不覆盖已有项目）', () => {
    withRoot((root) => {
      createProject(root, 'Dup', 'empty')
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-impdup-'))
      try {
        fs.writeFileSync(path.join(outside, 'project.json'), '{}')
        const r1 = importProjectFolder(root, outside, 'Dup')
        assert.equal(r1.renamed, true)
        assert.equal(r1.project.path, 'Dup (2)')
        const r2 = importProjectFolder(root, outside, 'dup')
        assert.equal(r2.renamed, true)
        assert.equal(r2.project.path, 'dup (3)', '大小写变体也算重名（后缀基于传入名）')
        assert.ok(fs.existsSync(path.join(root, 'Dup', 'project.json')), '原项目未被触碰')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })
  })
})
