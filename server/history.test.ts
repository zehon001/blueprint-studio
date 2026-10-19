/**
 * T7.4 自测 —— .history 自动快照（node:test）
 *
 * 运行：npx tsx --test server/history.test.ts
 *
 * 覆盖（任务卡硬性要求）：
 *  - 保存前快照：覆盖已存在文件产生快照 / 新建（不存在）不产生 / 子目录保持层级 /
 *    project.json 等任意项目内文件同样快照；
 *  - 快照上限：默认 20、超出淘汰最旧、snapshotFile 显式 limit、BP_HISTORY_LIMIT 解析
 *    （合法 / 非法 / 0 / 负数 / 小数 回落默认）；
 *  - 恢复往返：编辑回退（恢复前当前内容自动留快照，可再恢复撤销）；
 *    误删恢复（文件不存在也能从快照重建；删除前快照）；
 *  - 越权与保留目录（DoD 硬性）：.history（含大小写变体 / 深层同名段）不可经
 *    /api/file 写、DELETE、move 两端、import 目标直接触碰；ts 非法格式 400；
 *    快照不存在 404；上跳越权经 history 端点仍被既有安全根机制拒绝；
 *  - 隐藏：快照目录不出现在 /api/tree；isHiddenRelPath 供 watch 事件过滤。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HISTORY_LIMIT_DEFAULT,
  createProject,
  deletePathSafe,
  historyLimit,
  importIntoProject,
  isHiddenRelPath,
  listHistory,
  movePath,
  readFileSafe,
  readTree,
  resolveProjectScoped,
  restoreHistory,
  snapshotFile,
  writeFileSafe,
} from './fs'

/* ============================================================
 * 工具（与 fs.test.ts 的 withRoot / seed 同模式）
 * ============================================================ */

/** 建临时安全根跑一个用例，结束后清理 */
function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-history-'))
  try {
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** 在安全根内建一个 empty 模板项目，返回项目目录绝对路径 */
function seed(root: string, name = 'Proj'): string {
  createProject(root, name, 'empty')
  return path.join(root, name)
}

function expectFsError(fn: () => unknown, status: number, label: string): void {
  try {
    fn()
    assert.fail(`应当被拒绝（${label}）`)
  } catch (e) {
    assert.ok(e instanceof Error, `${label}: 应抛 FsError，实际 ${String(e)}`)
    assert.equal((e as Error & { status?: number }).status, status, label)
  }
}

/** 某文件的全部快照 .bak 绝对路径（时间序升序） */
function snapshotBakPaths(root: string, relInProject: string): string[] {
  const dir = path.join(root, 'Proj', '.history', ...relInProject.split('/'))
  const keyOf = (name: string): [string, number] => {
    const ts = name.slice(0, -'.bak'.length)
    const m = /^(\d{8}-\d{6}-\d{3})(?:-(\d+))?$/.exec(ts)
    return m ? [m[1]!, Number(m[2] ?? 0)] : [ts, 0]
  }
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.bak'))
      .sort((a, b) => {
        const [ta, sa] = keyOf(a)
        const [tb, sb] = keyOf(b)
        if (ta !== tb) return ta < tb ? -1 : 1
        return sa - sb
      })
      .map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

/* ============================================================
 * 保存前快照的产生
 * ============================================================ */

describe('保存前快照（PUT /api/file 覆盖已有文件时）', () => {
  test('新建文件不产生快照；覆盖时把旧内容留存 .history', () => {
    withRoot((root) => {
      seed(root)
      // 新建：无快照（empty 模板自带 ui/main.ui.json，这里用模板中不存在的文件）
      const w1 = writeFileSafe(root, 'Proj/ui/extra.ui.json', 'v1')
      assert.equal(w1.snapshotTs, undefined, '新建文件不应产生快照')
      assert.equal(listHistory(root, 'Proj/ui/extra.ui.json').entries.length, 0)
      // 覆盖：旧内容 v1 进快照
      const w2 = writeFileSafe(root, 'Proj/ui/extra.ui.json', 'v2')
      assert.equal(typeof w2.snapshotTs, 'string', '覆盖应返回快照时间戳')
      const baks = snapshotBakPaths(root, 'ui/extra.ui.json')
      assert.equal(baks.length, 1)
      assert.equal(fs.readFileSync(baks[0], 'utf8'), 'v1', '快照内容 = 覆盖前的旧内容')
      const listed = listHistory(root, 'Proj/ui/extra.ui.json')
      assert.equal(listed.path, 'Proj/ui/extra.ui.json')
      assert.equal(listed.entries.length, 1)
      assert.equal(listed.entries[0].ts, w2.snapshotTs)
      assert.equal(listed.entries[0].size, Buffer.byteLength('v1', 'utf8'))
      assert.equal(typeof listed.entries[0].mtime, 'string')
      // 快照文件名主干为 20261017-142530-123 形式
      assert.match(path.basename(baks[0]), /^\d{8}-\d{6}-\d{3}(-\d{1,4})?\.bak$/)
    })
  })

  test('子目录文件快照保持层级（.history/<相对路径>/）', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/logic/sub/deep/x.ts', 'v1')
      writeFileSafe(root, 'Proj/logic/sub/deep/x.ts', 'v2')
      const baks = snapshotBakPaths(root, 'logic/sub/deep/x.ts')
      assert.equal(baks.length, 1)
      assert.ok(
        baks[0].split(path.sep).join('/').includes('Proj/.history/logic/sub/deep/x.ts/'),
        '快照目录应保持项目内子目录层级',
      )
      assert.equal(fs.readFileSync(baks[0], 'utf8'), 'v1')
    })
  })

  test('project.json 覆盖同样产生快照（任意项目内文件）', () => {
    withRoot((root) => {
      seed(root)
      const before = readFileSafe(root, 'Proj/project.json').content
      writeFileSafe(root, 'Proj/project.json', '{"name":"改过"}')
      const baks = snapshotBakPaths(root, 'project.json')
      assert.equal(baks.length, 1)
      assert.equal(fs.readFileSync(baks[0], 'utf8'), before)
    })
  })
})

/* ============================================================
 * 快照上限（可配）
 * ============================================================ */

describe('快照上限淘汰（默认 20，超出删最旧）', () => {
  test('连续覆盖 25 版：只保留最近 20 份快照，最旧被淘汰', () => {
    withRoot((root) => {
      seed(root)
      for (let v = 0; v <= 24; v++) writeFileSafe(root, 'Proj/a.txt', `v${v}`)
      // 写 v0 新建无快照；写 v1..v24 各产生一份（内容 = v0..v23）→ 24 份裁剪到 20
      const baks = snapshotBakPaths(root, 'a.txt')
      assert.equal(baks.length, HISTORY_LIMIT_DEFAULT)
      const listed = listHistory(root, 'Proj/a.txt')
      assert.equal(listed.entries.length, 20)
      // 最旧的一份应是「v4 的快照」（v0..v3 的快照被淘汰；同毫秒快照带零填充序号，字典序=时间序）
      const oldest = fs.readFileSync(baks[0], 'utf8')
      assert.equal(oldest, 'v4')
      const newest = fs.readFileSync(baks[baks.length - 1], 'utf8')
      assert.equal(newest, 'v23')
      assert.equal(listed.entries[0].ts, path.basename(baks[baks.length - 1], '.bak'), '列表新 → 旧')
    })
  })

  test('snapshotFile 显式 limit 生效（裁剪到指定份数）', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/a.txt', 'v0')
      const scope = resolveProjectScoped(root, 'Proj/a.txt')
      for (let i = 0; i < 5; i++) {
        writeFileSafe(root, 'Proj/a.txt', `w${i}`)
        const ts = snapshotFile(scope, 2)
        assert.equal(typeof ts, 'string')
      }
      const baks = snapshotBakPaths(root, 'a.txt')
      assert.equal(baks.length, 2, '上限 2 → 只保留最新 2 份')
    })
  })

  test('BP_HISTORY_LIMIT 环境变量解析（合法生效，非法回落默认 20）', () => {
    const saved = process.env.BP_HISTORY_LIMIT
    try {
      delete process.env.BP_HISTORY_LIMIT
      assert.equal(historyLimit(), HISTORY_LIMIT_DEFAULT)
      process.env.BP_HISTORY_LIMIT = '5'
      assert.equal(historyLimit(), 5)
      process.env.BP_HISTORY_LIMIT = ' 7 '
      assert.equal(historyLimit(), 7, '允许首尾空白')
      process.env.BP_HISTORY_LIMIT = 'abc'
      assert.equal(historyLimit(), HISTORY_LIMIT_DEFAULT, '非数字回落默认')
      process.env.BP_HISTORY_LIMIT = '0'
      assert.equal(historyLimit(), HISTORY_LIMIT_DEFAULT, '0 非法（至少保留 1 份）')
      process.env.BP_HISTORY_LIMIT = '-3'
      assert.equal(historyLimit(), HISTORY_LIMIT_DEFAULT, '负数回落默认')
      process.env.BP_HISTORY_LIMIT = '3.5'
      assert.equal(historyLimit(), HISTORY_LIMIT_DEFAULT, '小数回落默认')
    } finally {
      if (saved === undefined) delete process.env.BP_HISTORY_LIMIT
      else process.env.BP_HISTORY_LIMIT = saved
    }
  })
})

/* ============================================================
 * 恢复往返
 * ============================================================ */

describe('恢复（POST /api/history/restore 语义）', () => {
  test('编辑回退：恢复旧版本；恢复前当前内容自动留快照（可再恢复撤销）', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/a.txt', 'v1')
      writeFileSafe(root, 'Proj/a.txt', 'v2') // 快照 v1
      writeFileSafe(root, 'Proj/a.txt', 'v3') // 快照 v2
      const { entries } = listHistory(root, 'Proj/a.txt')
      assert.equal(entries.length, 2)
      const oldestTs = entries[entries.length - 1].ts // v1 的快照
      const r = restoreHistory(root, 'Proj/a.txt', oldestTs)
      assert.equal(r.ok, true)
      assert.equal(r.path, 'Proj/a.txt')
      assert.equal(r.size, Buffer.byteLength('v1', 'utf8'))
      assert.equal(readFileSafe(root, 'Proj/a.txt').content, 'v1', '内容回到 v1')
      assert.equal(typeof r.preRestoreTs, 'string', '恢复前给 v3 做了快照')
      // 现在 3 份快照：[v3 的恢复前快照, v2, v1]，恢复本身可撤销
      const after = listHistory(root, 'Proj/a.txt')
      assert.equal(after.entries.length, 3)
      const back = restoreHistory(root, 'Proj/a.txt', r.preRestoreTs ?? '')
      assert.equal(readFileSafe(root, 'Proj/a.txt').content, 'v3', '再恢复 = 撤销刚才的恢复')
      // 回退前又给 v1 做了快照（内容与最早那份一致）——恢复链上任一点都可再找回
      assert.equal(typeof back.preRestoreTs, 'string')
      const backSnap = path.join(root, 'Proj', '.history', 'a.txt', `${back.preRestoreTs}.bak`)
      assert.equal(fs.readFileSync(backSnap, 'utf8'), 'v1')
    })
  })

  test('误删恢复：文件不存在也能从快照重建；删除前快照同样可恢复', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/a.txt', 'v1')
      writeFileSafe(root, 'Proj/a.txt', 'v2') // 快照：v1
      const preDelete = listHistory(root, 'Proj/a.txt').entries.map((e) => e.ts)
      const del = deletePathSafe(root, 'Proj/a.txt')
      assert.equal(typeof del.snapshotTs, 'string', '删除文件前自动留快照')
      assert.throws(() => readFileSafe(root, 'Proj/a.txt'), /不存在/, '文件已被删除')
      const entries = listHistory(root, 'Proj/a.txt').entries
      assert.equal(entries.length, 2, '文件已删除仍可列出快照（误删恢复入口）')
      assert.equal(entries[0].ts, del.snapshotTs, '最新一份 = 删除前的内容 v2')
      // 用最早的快照（v1）恢复
      const oldestTs = entries[entries.length - 1].ts
      assert.equal(oldestTs, preDelete[0])
      const r = restoreHistory(root, 'Proj/a.txt', oldestTs)
      assert.equal(r.preRestoreTs, null, '当前文件不存在 → 无恢复前快照')
      assert.equal(readFileSafe(root, 'Proj/a.txt').content, 'v1', '误删文件从快照重建')
      // 再恢复到删除前最新内容（v2），验证恢复撤销链
      restoreHistory(root, 'Proj/a.txt', del.snapshotTs ?? '')
      assert.equal(readFileSafe(root, 'Proj/a.txt').content, 'v2')
    })
  })

  test('恢复目标是目录被拒（400）', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/d2.txt', 'v1')
      writeFileSafe(root, 'Proj/d2.txt', 'v2') // 留下 v1 快照
      deletePathSafe(root, 'Proj/d2.txt')
      fs.mkdirSync(path.join(root, 'Proj', 'd2.txt')) // 同名目录占用恢复目标
      const ts = listHistory(root, 'Proj/d2.txt').entries[0].ts
      expectFsError(() => restoreHistory(root, 'Proj/d2.txt', ts), 400, '恢复目标为目录')
    })
  })
})

/* ============================================================
 * 越权与保留目录（DoD 硬性）
 * ============================================================ */

describe('保留目录 .history 的越权防护', () => {
  test('.history 不可直接经 /api/file 写入（含大小写变体 / 深层同名段）', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/ui/main.ui.json', 'v1')
      writeFileSafe(root, 'Proj/ui/main.ui.json', 'v2') // 确保有真实快照存在
      expectFsError(
        () => writeFileSafe(root, 'Proj/.history/ui/main.ui.json/20260101-000000-000.bak', 'hack'),
        403,
        '直写快照文件',
      )
      expectFsError(() => writeFileSafe(root, 'Proj/.history/x.txt', 'x'), 403, '写 .history 根下')
      expectFsError(() => writeFileSafe(root, 'Proj/.HISTORY/x.txt', 'x'), 403, '大小写变体')
      expectFsError(() => writeFileSafe(root, 'Proj/assets/.history/x.txt', 'x'), 403, '深层同名段')
      expectFsError(() => writeFileSafe(root, 'Proj/.history', 'x'), 403, '目标是 .history 本身')
    })
  })

  test('.history 不可经 DELETE / move / import 触碰', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/a.txt', 'x')
      expectFsError(() => deletePathSafe(root, 'Proj/.history'), 403, '删除 .history 目录')
      expectFsError(() => deletePathSafe(root, 'Proj/.history/a.txt'), 403, '删除快照文件')
      expectFsError(() => movePath(root, { from: 'Proj/a.txt', to: 'Proj/.history/a.txt' }), 403, '移入 .history')
      expectFsError(() => movePath(root, { from: 'Proj/.history/a.txt', to: 'Proj/b.txt' }), 403, '移出 .history')
      expectFsError(
        () => importIntoProject(root, 'Proj/.history', path.join(root, 'Proj', 'a.txt')),
        403,
        '导入目标在 .history',
      )
    })
  })

  test('ts 参数校验：非法格式 400 / 快照不存在 404 / 项目根 400', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/a.txt', 'v1')
      writeFileSafe(root, 'Proj/a.txt', 'v2')
      expectFsError(() => restoreHistory(root, 'Proj/a.txt', 42), 400, 'ts 非字符串')
      expectFsError(() => restoreHistory(root, 'Proj/a.txt', '../x'), 400, 'ts 上跳注入')
      expectFsError(() => restoreHistory(root, 'Proj/a.txt', 'a/b.bak'), 400, 'ts 含分隔符')
      expectFsError(() => restoreHistory(root, 'Proj/a.txt', '20260101-0000'), 400, 'ts 格式不全')
      expectFsError(() => restoreHistory(root, 'Proj/a.txt', '20260101-000000-000'), 404, '快照不存在')
      expectFsError(() => restoreHistory(root, 'Proj', '20260101-000000-000'), 400, 'path 为项目根')
      expectFsError(() => listHistory(root, 'Proj'), 400, 'list 项目根')
      expectFsError(() => listHistory(root, 'Proj/.history'), 400, 'list .history 自身')
      expectFsError(() => listHistory(root, 'Proj/.history/a.txt/20260101-000000-000.bak'), 400, 'list 快照文件')
      // 从未保存过的文件：空列表而非 404（新建文件还没历史是正常态）
      assert.deepEqual(listHistory(root, 'Proj/logic/never.txt').entries, [])
    })
  })

  test('上跳等越权路径经 history 端点仍被安全根机制拒绝', () => {
    withRoot((root) => {
      seed(root)
      expectFsError(() => restoreHistory(root, '../escape.txt', '20260101-000000-000'), 403, '恢复端点上跳')
      expectFsError(() => listHistory(root, 'Proj/../../escape.txt'), 403, 'list 端点穿项目上跳')
      expectFsError(() => restoreHistory(root, 'C:/Windows/x', '20260101-000000-000'), 403, '盘符绝对路径')
    })
  })
})

/* ============================================================
 * 隐藏：树不显示、watch 事件过滤
 * ============================================================ */

describe('.history 隐藏', () => {
  test('快照目录不出现在 /api/tree', () => {
    withRoot((root) => {
      seed(root)
      writeFileSafe(root, 'Proj/ui/main.ui.json', 'v1')
      writeFileSafe(root, 'Proj/ui/main.ui.json', 'v2') // 产生 .history/ui/main.ui.json/
      const tree = readTree(root, 'Proj')
      const names = tree.children.map((c) => c.name)
      assert.equal(names.includes('.history'), false, '项目根子项不含 .history')
      const ui = tree.children.find((c) => c.name === 'ui')
      assert.equal(ui?.children.some((c) => c.name === '.history'), false, 'ui/ 下同样不显示')
    })
  })

  test('isHiddenRelPath：任意层级的 .history 段命中（watch 事件过滤用）', () => {
    assert.equal(isHiddenRelPath('.history/ui/main.ui.json/20260101-000000-000.bak'), true)
    assert.equal(isHiddenRelPath('ui/.history/x'), true)
    assert.equal(isHiddenRelPath('ui/main.ui.json'), false)
    assert.equal(isHiddenRelPath('ui/history/x'), false, '无点前缀不算')
    assert.equal(isHiddenRelPath(''), false)
  })
})
