/**
 * 资源库服务端自测（纯蓝图工作流：仅函数库；node:test）
 *
 * 覆盖：安全根（默认根 / BP_LIBRARY_ROOT 覆盖 / 与项目根重叠拒绝）、路径与名称安全、
 * CRUD 与快照（覆盖 / 删除 / 改名 / 恢复）、BP_HISTORY_LIMIT、导出导入（manifest 指纹 +
 * @library 依赖闭包 + zip 往返 + 冲突三策略 + 安全拒绝）、SSE 回调层、@library 引用收集。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  LIBRARY_HISTORY_DIR,
  LIBRARY_KINDS,
  assertLibraryRootSeparate,
  collectLibraryRefs,
  createZipArchive,
  defaultLibraryRoot,
  deleteLibraryEntry,
  ensureLibraryRoot,
  exportLibraryBundle,
  exportLibraryZip,
  importLibraryZip,
  libraryEntryPath,
  libraryRoot,
  librarySubscriberCount,
  listLibrary,
  listLibraryHistory,
  onLibraryChange,
  readLibraryEntry,
  readZipArchive,
  renameLibraryEntry,
  restoreLibraryHistory,
  sha256Hex,
  validateLibraryName,
  writeLibraryEntry,
} from './library'
import type { LibraryChangeEvent } from './library'

/* ============================================================
 * 工具
 * ============================================================ */

function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-library-'))
  try {
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function expectFsError(fn: () => unknown, status: number, label: string): void {
  try {
    fn()
    assert.fail(`应当被拒绝（${label}）`)
  } catch (e) {
    assert.ok(e instanceof Error, `${label}: 应抛 FsError，实际 ${String(e)}`)
    const err = e as Error & { status?: number }
    assert.equal(err.status, status, `${label}: ${err.message}`)
    assert.match(err.message, /[\u4e00-\u9fff]/, `${label}: 错误消息应为中文（${err.message}）`)
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function fnAsset(name: string, extra: Record<string, unknown> = {}): string {
  return json({ version: 3, kind: 'function', scope: 'global', name, params: [], returns: [], graph: { nodes: [], edges: [] }, ...extra })
}

/* ============================================================
 * 库根解析与独立安全根
 * ============================================================ */

describe('库根解析与独立安全根', () => {
  test('默认库根 = <home>/.blueprint-studio/library；BP_LIBRARY_ROOT 覆盖', () => {
    withEnv({ BP_LIBRARY_ROOT: undefined }, () => {
      assert.equal(
        libraryRoot(),
        path.resolve(path.join(os.homedir(), '.blueprint-studio', 'library')),
        '默认库根应位于用户主目录',
      )
      assert.equal(defaultLibraryRoot(), libraryRoot())
    })
    withRoot((tmp) => {
      withEnv({ BP_LIBRARY_ROOT: tmp }, () => {
        assert.equal(libraryRoot(), path.resolve(tmp))
      })
    })
  })

  test('ensureLibraryRoot 创建库根与 functions/.history', () => {
    withRoot((root) => {
      const abs = ensureLibraryRoot(root)
      assert.equal(abs, path.resolve(root))
      for (const sub of [...LIBRARY_KINDS, LIBRARY_HISTORY_DIR]) {
        assert.ok(fs.statSync(path.join(abs, sub)).isDirectory(), `应创建 ${sub}/`)
      }
      assert.equal(ensureLibraryRoot(root), abs)
    })
  })

  test('库根与项目安全根重叠（位于项目根内 / 包含项目根 / 等于项目根）→ 403', () => {
    withRoot((root) => {
      const projectsRoot = path.join(root, 'projects')
      fs.mkdirSync(projectsRoot, { recursive: true })
      withEnv({ BP_PROJECTS_ROOT: projectsRoot }, () => {
        expectFsError(() => ensureLibraryRoot(path.join(projectsRoot, 'library')), 403, '库根位于项目根内')
        expectFsError(() => ensureLibraryRoot(root), 403, '库根包含项目根')
        expectFsError(() => ensureLibraryRoot(projectsRoot), 403, '库根等于项目根')
        assert.equal(ensureLibraryRoot(path.join(root, 'library')), path.join(root, 'library'))
      })
    })
  })

  test('assertLibraryRootSeparate：路径规范化后仍能检出重叠', () => {
    withRoot((root) => {
      const projectsRoot = path.join(root, 'proj')
      fs.mkdirSync(projectsRoot, { recursive: true })
      expectFsError(
        () => assertLibraryRootSeparate(path.join(root, 'x', '..', 'proj', 'lib'), projectsRoot),
        403,
        '含 .. 的重叠',
      )
    })
  })

  test('库根位置是文件 / 无法创建 → 500 中文错误', () => {
    withRoot((root) => {
      const filePath = path.join(root, 'library-file')
      fs.writeFileSync(filePath, 'x')
      expectFsError(() => ensureLibraryRoot(filePath), 500, '库根是文件')
    })
  })

  test('normalizeLibraryKind：未知类型 400（仅 functions）', () => {
    withRoot((root) => {
      for (const bad of ['', 'element', 'Elements', 'styles ', 'function', 42, null]) {
        expectFsError(() => listLibrary(bad, root), 400, `kind=${String(bad)}`)
      }
      assert.equal(listLibrary('functions', root).length, 0)
    })
  })
})

/* ============================================================
 * 条目名 / 路径安全
 * ============================================================ */

describe('条目名与路径安全', () => {
  test('合法名：中文 / 空格 / 括号 / 内部单点保留', () => {
    for (const name of ['base', 'formatDuration', '我的函数', 'my.fn', 'card compact', 'card (2)']) {
      assert.equal(validateLibraryName(name), name)
    }
    assert.equal(validateLibraryName('  base  '), 'base', '首尾空白被归一化')
  })

  test('非法名全部 400（.. / 绝对路径 / 盘符 / 分隔符 / 控制字符 / 保留名 / 带扩展名）', () => {
    const bad: unknown[] = [
      '', '   ', '..', '../x', 'a/b', 'a\\b', '/abs', 'C:\\x', 'C:/x',
      '.hidden', 'a.', 'CON', 'com1', 'formatDuration.fn.json', 'x\u0000y', 'x\u0001y',
      'x'.repeat(65), 'a..b', 42, null, undefined,
    ]
    for (const name of bad) {
      expectFsError(() => validateLibraryName(name), 400, `name=${String(name)}`)
    }
  })

  test('未知 kind 的写 / 读 / 删都 400；非法名在读 / 删入口同样被拒', () => {
    withRoot((root) => {
      expectFsError(() => writeLibraryEntry('element', 'x', '{}', root), 400, '写未知 kind')
      expectFsError(() => readLibraryEntry('functions', '../x', root), 400, '读上跳名')
      expectFsError(() => deleteLibraryEntry('functions', 'a/b', root), 400, '删斜杠名')
    })
  })

  test('libraryEntryPath 不越过库根；带 .. 的名字在拼接前被拒', () => {
    withRoot((root) => {
      const abs = libraryEntryPath('functions', 'fmt', root)
      assert.ok(abs.startsWith(path.resolve(root) + path.sep))
      assert.equal(path.basename(abs), 'fmt.fn.json')
      expectFsError(() => libraryEntryPath('functions', '..', root), 400, '点段')
    })
  })
})

/* ============================================================
 * CRUD
 * ============================================================ */

describe('CRUD 与快照', () => {
  test('写入 → 列表 → 读取（指纹一致）；新建不产生快照', () => {
    withRoot((root) => {
      const content = fnAsset('fmt')
      const w = writeLibraryEntry('functions', 'fmt', content, root)
      assert.equal(w.ok, true)
      assert.equal(w.created, true)
      assert.equal(w.snapshotTs, null)
      assert.equal(w.path, 'functions/fmt.fn.json')
      assert.equal(w.size, Buffer.byteLength(content, 'utf8'))
      assert.equal(w.sha256, createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'))

      const entries = listLibrary('functions', root)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].name, 'fmt')
      assert.match(entries[0].mtime, /^\d{4}-\d{2}-\d{2}T/)

      const read = readLibraryEntry('functions', 'fmt', root)
      assert.equal(read.content, content)
      assert.equal(read.sha256, w.sha256)
      assert.equal(listLibraryHistory('functions', 'fmt', root).entries.length, 0)
    })
  })

  test('覆盖写入：created=false + 旧内容进入 .history，恢复可回退', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'fmt', 'v1', root)
      const w2 = writeLibraryEntry('functions', 'fmt', 'v2', root)
      assert.equal(w2.created, false)
      assert.equal(typeof w2.snapshotTs, 'string')
      const history = listLibraryHistory('functions', 'fmt', root)
      assert.equal(history.entries.length, 1)
      const restored = restoreLibraryHistory('functions', 'fmt', w2.snapshotTs, root)
      assert.equal(restored.preRestoreTs === null, false, '恢复前应为当前内容留快照')
      assert.equal(readLibraryEntry('functions', 'fmt', root).content, 'v1')
    })
  })

  test('删除：删除前快照保留，条目消失但历史可查 / 可恢复', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'fmt', 'fn-v1', root)
      const del = deleteLibraryEntry('functions', 'fmt', root)
      assert.equal(del.ok, true)
      assert.equal(typeof del.snapshotTs, 'string')
      assert.equal(listLibrary('functions', root).length, 0)
      expectFsError(() => readLibraryEntry('functions', 'fmt', root), 404, '删除后读取')
      const restored = restoreLibraryHistory('functions', 'fmt', del.snapshotTs, root)
      assert.equal(restored.preRestoreTs, null, '误删恢复：当前不存在，无恢复前快照')
      assert.equal(readLibraryEntry('functions', 'fmt', root).content, 'fn-v1')
    })
  })

  test('改名：同类型内移动 / 冲突 409 / overwrite 覆盖（目标留快照）', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'Old', 'old-content', root)
      const renamed = renameLibraryEntry('functions', 'Old', 'New', { root })
      assert.equal(renamed.moved, true)
      assert.equal(renamed.name, 'New')
      assert.equal(renamed.path, 'functions/New.fn.json')
      expectFsError(() => readLibraryEntry('functions', 'Old', root), 404, '旧名不存在')
      assert.equal(readLibraryEntry('functions', 'New', root).content, 'old-content')

      writeLibraryEntry('functions', 'Target', 'target-content', root)
      expectFsError(() => renameLibraryEntry('functions', 'New', 'Target', { root }), 409, '目标已存在且未覆盖')
      const replaced = renameLibraryEntry('functions', 'New', 'Target', { root, overwrite: true })
      assert.equal(replaced.name, 'Target')
      assert.equal(readLibraryEntry('functions', 'Target', root).content, 'old-content')
      assert.equal(listLibrary('functions', root).length, 1)
      const history = listLibraryHistory('functions', 'Target', root)
      assert.ok(history.entries.some((e) => e.ts === replaced.replacedSnapshotTs))
    })
  })

  test('改名：同名 no-op；仅大小写改名成功且列表只剩一个', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'Base', 'x', root)
      const noop = renameLibraryEntry('functions', 'Base', 'Base', { root })
      assert.equal(noop.moved, false)
      const caseOnly = renameLibraryEntry('functions', 'Base', 'base', { root })
      assert.equal(caseOnly.moved, true)
      const list = listLibrary('functions', root)
      assert.equal(list.length, 1)
      assert.equal(list[0].name, 'base')
    })
  })

  test('改名 / 删除不存在的条目 → 404 中文错误', () => {
    withRoot((root) => {
      ensureLibraryRoot(root)
      expectFsError(() => renameLibraryEntry('functions', 'nope', 'x', { root }), 404, '改名源不存在')
      expectFsError(() => deleteLibraryEntry('functions', 'nope', root), 404, '删除不存在')
    })
  })

  test('content 必须为字符串；超大内容 413', () => {
    withRoot((root) => {
      expectFsError(() => writeLibraryEntry('functions', 'x', { version: 3 }, root), 400, '非字符串')
      expectFsError(
        () => writeLibraryEntry('functions', 'big', 'x'.repeat(8 * 1024 * 1024 + 1), root),
        413,
        '超大内容',
      )
    })
  })
})

/* ============================================================
 * 历史快照
 * ============================================================ */

describe('历史快照', () => {
  test('BP_HISTORY_LIMIT 控制上限：只保留最新 N 份（淘汰最旧）', () => {
    withRoot((root) => {
      withEnv({ BP_HISTORY_LIMIT: '2' }, () => {
        for (const v of ['v1', 'v2', 'v3', 'v4']) writeLibraryEntry('functions', 'fmt', v, root)
        const history = listLibraryHistory('functions', 'fmt', root)
        assert.equal(history.entries.length, 2, '上限 2 份')
        const oldest = history.entries[history.entries.length - 1]
        restoreLibraryHistory('functions', 'fmt', oldest.ts, root)
        assert.equal(readLibraryEntry('functions', 'fmt', root).content, 'v2', '最旧的 v1 已被淘汰')
      })
    })
  })

  test('非法 ts / 不存在快照 → 400 / 404', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'fmt', 'v1', root)
      for (const ts of ['', '..', '../../x', '2026', '20260101-000000', 123, null]) {
        expectFsError(() => restoreLibraryHistory('functions', 'fmt', ts, root), 400, `ts=${String(ts)}`)
      }
      expectFsError(
        () => restoreLibraryHistory('functions', 'fmt', '20260101-000000-000', root),
        404,
        '快照不存在',
      )
    })
  })

  test('同毫秒多次快照产生不同 ts（字典序 = 时间序）', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'fmt', 'v0', root)
      for (let i = 1; i <= 5; i++) writeLibraryEntry('functions', 'fmt', `v${i}`, root)
      const entries = listLibraryHistory('functions', 'fmt', root).entries
      assert.equal(entries.length, 5)
      const tsList = entries.map((e) => e.ts)
      assert.equal(new Set(tsList).size, 5, 'ts 必须唯一')
      for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i - 1].ts > entries[i].ts, '应按时间倒序排列')
      }
    })
  })
})

/* ============================================================
 * 导出 / 导入
 * ============================================================ */

/** 造一个含依赖闭包的库：helper ← caller（内容引用 @library/functions/helper） */
function seedExportLibrary(root: string): void {
  writeLibraryEntry('functions', 'helper', fnAsset('helper'), root)
  writeLibraryEntry('functions', 'caller', fnAsset('caller', { ref: '@library/functions/helper' }), root)
}

describe('导出（manifest 指纹 + 依赖闭包）', () => {
  test('选中条目导出会带上 @library 依赖闭包，manifest 指纹与文件一致', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const bundle = exportLibraryBundle({ entries: [{ kind: 'functions', name: 'caller' }], root })
      assert.equal(bundle.ok, true)
      assert.deepEqual(bundle.files.map((f) => f.name), ['caller', 'helper'])
      assert.deepEqual(bundle.missing, [])
      assert.equal(bundle.manifest.version, 1)
      assert.equal(bundle.manifest.entries.length, 2)
      for (const entry of bundle.manifest.entries) {
        const file = bundle.files.find((f) => f.kind === entry.kind && f.name === entry.name)
        assert.ok(file)
        assert.equal(entry.sha256, sha256Hex(file.content))
      }
    })
  })

  test('缺省/空选择：缺省 = 全部条目；[] = 空包（只有 manifest）', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      assert.equal(exportLibraryBundle({ root }).files.length, 2)
      const empty = exportLibraryBundle({ entries: [], root })
      assert.equal(empty.files.length, 0)
      assert.equal(empty.manifest.entries.length, 0)
    })
  })

  test('显式选择不存在的条目 → 404；缺失依赖只记入 missing 不阻断导出', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      expectFsError(
        () => exportLibraryBundle({ entries: [{ kind: 'functions', name: 'Ghost' }], root }),
        404,
        '导出不存在条目',
      )
      writeLibraryEntry('functions', 'broken', fnAsset('broken', { ref: '@library/functions/missing' }), root)
      const bundle = exportLibraryBundle({ entries: [{ kind: 'functions', name: 'broken' }], root })
      assert.deepEqual(bundle.missing, [{ kind: 'functions', name: 'missing' }])
      assert.equal(bundle.files.length, 1)
    })
  })

  test('includeDependencies=false 只导出选中条目', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const bundle = exportLibraryBundle({
        entries: [{ kind: 'functions', name: 'caller' }],
        includeDependencies: false,
        root,
      })
      assert.deepEqual(bundle.files.map((f) => f.name), ['caller'])
    })
  })

  test('zip 内含 manifest.json + functions/<name>.fn.json，且可被自身读取', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const result = exportLibraryZip({ entries: [{ kind: 'functions', name: 'caller' }], root })
      assert.equal(result.entryCount, 2)
      assert.ok(result.bytes > 0)
      const files = readZipArchive(result.zip)
      assert.deepEqual(files.map((f) => f.path), [
        'manifest.json',
        'functions/caller.fn.json',
        'functions/helper.fn.json',
      ])
    })
  })
})

describe('导入（zip / 冲突策略 / 安全）', () => {
  test('导出 → 导入空库往返：内容与指纹一致', () => {
    withRoot((source) => {
      seedExportLibrary(source)
      const zip = exportLibraryZip({ entries: [{ kind: 'functions', name: 'caller' }], root: source }).zip
      withRoot((target) => {
        const result = importLibraryZip(zip, { root: target })
        assert.equal(result.ok, true)
        assert.equal(result.verified, true)
        assert.deepEqual(result.summary, { created: 2, overwritten: 0, renamed: 0, skipped: 0 })
        for (const entry of listLibrary('functions', target)) {
          assert.equal(
            readLibraryEntry('functions', entry.name, target).sha256,
            readLibraryEntry('functions', entry.name, source).sha256,
          )
        }
      })
    })
  })

  test('冲突策略 skip / overwrite / rename', () => {
    withRoot((source) => {
      writeLibraryEntry('functions', 'fmt', 'imported', source)
      const zip = exportLibraryZip({ root: source }).zip
      withRoot((target) => {
        writeLibraryEntry('functions', 'fmt', 'local', target)
        const skipped = importLibraryZip(zip, { root: target, policy: 'skip' })
        assert.equal(skipped.summary.skipped, 1)
        assert.equal(readLibraryEntry('functions', 'fmt', target).content, 'local')
        assert.equal(listLibraryHistory('functions', 'fmt', target).entries.length, 0, 'skip 不写快照')

        const overwritten = importLibraryZip(zip, { root: target, policy: 'overwrite' })
        assert.equal(overwritten.summary.overwritten, 1)
        assert.equal(readLibraryEntry('functions', 'fmt', target).content, 'imported')
        assert.equal(listLibraryHistory('functions', 'fmt', target).entries.length, 1, '覆盖前快照')
      })
      withRoot((target) => {
        writeLibraryEntry('functions', 'fmt', 'local', target)
        const renamed = importLibraryZip(zip, { root: target, policy: 'rename' })
        assert.equal(renamed.summary.renamed, 1)
        assert.equal(renamed.imported[0].to, 'fmt (2)')
        assert.equal(readLibraryEntry('functions', 'fmt', target).content, 'local')
        assert.equal(readLibraryEntry('functions', 'fmt (2)', target).content, 'imported')
      })
    })
  })

  test('无 manifest 的 zip 允许导入（verified=false）；重复条目 400', () => {
    withRoot((root) => {
      const noManifest = createZipArchive([
        { path: 'functions/plain.fn.json', content: Buffer.from('{}') },
      ])
      const result = importLibraryZip(noManifest, { root })
      assert.equal(result.verified, false)
      assert.equal(result.summary.created, 1)
      assert.equal(readLibraryEntry('functions', 'plain', root).content, '{}')

      const duplicate = createZipArchive([
        { path: 'functions/dup.fn.json', content: Buffer.from('{}') },
        { path: 'functions/Dup.fn.json', content: Buffer.from('{}') },
      ])
      expectFsError(() => importLibraryZip(duplicate, { root }), 400, '重复条目')
    })
  })

  test('越权 zip 路径 / 跨类型扩展名 / 保留名 → 403 / 400', () => {
    withRoot((root) => {
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: 'functions/../../evil.fn.json', content: Buffer.from('{}') }]), { root }),
        403,
        '上跳路径',
      )
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: '/functions/x.fn.json', content: Buffer.from('{}') }]), { root }),
        403,
        '绝对路径',
      )
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: 'functions/CON.fn.json', content: Buffer.from('{}') }]), { root }),
        400,
        '保留设备名',
      )
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: 'functions/x.uss.json', content: Buffer.from('{}') }]), { root }),
        400,
        '跨类型扩展名',
      )
      expectFsError(() => importLibraryZip(Buffer.from('not a zip at all'), { root }), 400, '坏 zip')
      expectFsError(
        () => importLibraryZip(createZipArchive([]), { root, policy: 'merge' }),
        400,
        '未知冲突策略',
      )
    })
  })

  test('manifest 指纹不符 / 缺少条目 / 未列出条目 → 400（整包拒绝）', () => {
    withRoot((source) => {
      seedExportLibrary(source)
      const files = readZipArchive(exportLibraryZip({ root: source }).zip)
      const tampered = files.map((f) =>
        f.path === 'functions/caller.fn.json' ? { ...f, content: Buffer.from('{}') } : f,
      )
      withRoot((target) => {
        expectFsError(() => importLibraryZip(createZipArchive(tampered), { root: target }), 400, '指纹不符')
      })
      const manifest = JSON.parse(files[0].content.toString('utf8')) as {
        version: number
        createdAt: string
        entries: Array<{ kind: string; name: string; sha256: string }>
      }
      manifest.entries.push({ kind: 'functions', name: 'ghost', sha256: '0'.repeat(64) })
      const missingEntry = [
        { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
        ...files.slice(1),
      ]
      withRoot((target) => {
        expectFsError(() => importLibraryZip(createZipArchive(missingEntry), { root: target }), 400, 'manifest 缺条目')
      })
      const extra = [...files, { path: 'functions/extra.fn.json', content: Buffer.from('{}') }]
      withRoot((target) => {
        expectFsError(() => importLibraryZip(createZipArchive(extra), { root: target }), 400, '未列入 manifest')
      })
    })
  })
})

/* ============================================================
 * zip 基础
 * ============================================================ */

describe('最小 zip 读写', () => {
  test('store 模式往返：多文件 / 空文件 / CJK 路径', () => {
    const files = [
      { path: 'manifest.json', content: Buffer.from('{"version":1}') },
      { path: 'functions/我的函数.fn.json', content: Buffer.from('{}') },
      { path: 'functions/empty.fn.json', content: Buffer.alloc(0) },
    ]
    const zip = createZipArchive(files)
    const out = readZipArchive(zip)
    assert.deepEqual(out.map((f) => f.path), files.map((f) => f.path))
    for (let i = 0; i < files.length; i++) {
      assert.equal(out[i].content.toString('utf8'), files[i].content.toString('utf8'))
    }
  })

  test('CRC32 损坏 / 截断 → 400', () => {
    const zip = createZipArchive([{ path: 'a.txt', content: Buffer.from('HELLO_WORLD') }])
    const corrupted = Buffer.from(zip)
    const idx = corrupted.indexOf(Buffer.from('HELLO_WORLD'))
    assert.ok(idx > 0)
    corrupted[idx] = 'X'.charCodeAt(0)
    expectFsError(() => readZipArchive(corrupted), 400, 'CRC 损坏')
    expectFsError(() => readZipArchive(zip.subarray(0, 10)), 400, '截断')
  })
})

/* ============================================================
 * SSE 事件（回调层）
 * ============================================================ */

describe('库变更事件（SSE 数据源）', () => {
  test('write / rename / delete / restore 广播 { kind, name, action }', () => {
    withRoot((root) => {
      const events: LibraryChangeEvent[] = []
      const stop = onLibraryChange((e) => events.push(e))
      try {
        writeLibraryEntry('functions', 'A', 'v1', root)
        writeLibraryEntry('functions', 'A', 'v2', root)
        renameLibraryEntry('functions', 'A', 'B', { root })
        deleteLibraryEntry('functions', 'B', root)
        const history = listLibraryHistory('functions', 'B', root)
        restoreLibraryHistory('functions', 'B', history.entries[0].ts, root)
      } finally {
        stop()
      }
      assert.deepEqual(events, [
        { kind: 'functions', name: 'A', action: 'saved' },
        { kind: 'functions', name: 'A', action: 'saved' },
        { kind: 'functions', name: 'B', action: 'renamed', from: 'A' },
        { kind: 'functions', name: 'B', action: 'deleted' },
        { kind: 'functions', name: 'B', action: 'saved' },
      ])
    })
  })

  test('退订后不再收到事件；订阅者抛错不影响写操作', () => {
    withRoot((root) => {
      const events: LibraryChangeEvent[] = []
      const stop = onLibraryChange((e) => events.push(e))
      const before = librarySubscriberCount()
      stop()
      assert.equal(librarySubscriberCount(), before - 1)
      writeLibraryEntry('functions', 'fmt', 'v1', root)
      assert.equal(events.length, 0, '退订后不应收到事件')

      const unsubscribeThrow = onLibraryChange(() => {
        throw new Error('订阅者故意抛错')
      })
      try {
        const result = writeLibraryEntry('functions', 'fmt', 'v2', root)
        assert.equal(result.ok, true)
        assert.equal(readLibraryEntry('functions', 'fmt', root).content, 'v2')
      } finally {
        unsubscribeThrow()
      }
    })
  })

  test('import / export 只在写库时产生事件（skip 无事件）', () => {
    withRoot((source) => {
      writeLibraryEntry('functions', 'fmt', 'imported', source)
      const zip = exportLibraryZip({ root: source }).zip
      withRoot((target) => {
        writeLibraryEntry('functions', 'fmt', 'local', target)
        const events: LibraryChangeEvent[] = []
        const stop = onLibraryChange((e) => events.push(e))
        try {
          const skipped = importLibraryZip(zip, { root: target, policy: 'skip' })
          assert.equal(skipped.summary.skipped, 1)
          assert.equal(events.length, 0, 'skip 不应广播')
          importLibraryZip(zip, { root: target, policy: 'overwrite' })
          assert.deepEqual(events, [{ kind: 'functions', name: 'fmt', action: 'saved' }])
        } finally {
          stop()
        }
      })
    })
  })
})

/* ============================================================
 * 引用收集
 * ============================================================ */

describe('@library 引用收集', () => {
  test('嵌套对象/数组中的引用被收集；非法引用被忽略', () => {
    const refs = collectLibraryRefs({
      fn: '@library/functions/formatDuration',
      list: ['@library/functions/helper', '@library/functions/../evil'],
      text: 'not-a-ref',
    })
    assert.deepEqual(refs, [
      { kind: 'functions', name: 'formatDuration' },
      { kind: 'functions', name: 'helper' },
    ])
  })
})
