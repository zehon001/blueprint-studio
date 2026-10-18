/**
 * T11.4 / T11.6 自测 —— 资源库服务端（node:test）
 *
 * 运行：node ./node_modules/tsx/dist/cli.mjs --test server/library.test.ts
 *
 * 覆盖（任务卡硬性要求）：
 *  - 安全根：默认 %USERPROFILE%\.blueprint-studio\library、BP_LIBRARY_ROOT 覆盖、
 *    目录创建/可写校验、与项目根重叠（双向包含 / 相等）拒绝；
 *  - 路径与名称安全：`..` / 绝对路径 / 盘符 / UNC / 分隔符 / 控制字符 / 保留设备名 /
 *    隐藏名 / 带扩展名 / 跨类型访问 / 未知 kind 全部中文错误；
 *  - CRUD：写入/覆盖快照/列表/读取指纹/删除（删除前快照）/改名（冲突、覆盖、仅大小写）；
 *  - history：快照上限（BP_HISTORY_LIMIT）、列表新→旧、按快照恢复（含误删恢复 / 恢复前快照）、
 *    非法 ts / 快照不存在；
 *  - 导出导入：manifest 形状与 sha256 指纹、@library 依赖闭包、缺失依赖清单、zip 往返、
 *    冲突三策略（skip / overwrite / rename）、坏 zip / 越权路径 / 指纹不符 / manifest 缺条目 /
 *    无 manifest zip / 重复条目；
 *  - SSE 回调层：write/delete/rename/restore 广播 { kind, name, action }、退订、订阅者异常隔离。
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

/** 建临时库根跑一个用例，结束后清理 */
function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-library-'))
  try {
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** 临时设置/删除环境变量，结束后恢复（避免用例间串味） */
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
    // 中文错误：至少包含一个 CJK 字符
    assert.match(err.message, /[\u4e00-\u9fff]/, `${label}: 错误消息应为中文（${err.message}）`)
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
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

  test('ensureLibraryRoot 创建库根与 elements/styles/functions/.history', () => {
    withRoot((root) => {
      const abs = ensureLibraryRoot(root)
      assert.equal(abs, path.resolve(root))
      for (const sub of [...LIBRARY_KINDS, LIBRARY_HISTORY_DIR]) {
        assert.ok(fs.statSync(path.join(abs, sub)).isDirectory(), `应创建 ${sub}/`)
      }
      // 幂等
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
        // 平级目录可用
        assert.equal(ensureLibraryRoot(path.join(root, 'library')), path.join(root, 'library'))
      })
    })
  })

  test('assertLibraryRootSeparate：路径规范化后仍能检出重叠', () => {
    withRoot((root) => {
      const projectsRoot = path.join(root, 'proj')
      fs.mkdirSync(projectsRoot, { recursive: true })
      // 未 resolve 的冗余片段
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

  test('normalizeLibraryKind：未知类型 400（跨类型不落到别的目录）', () => {
    withRoot((root) => {
      for (const bad of ['', 'element', 'Elements', 'styles ', 'function', 42, null]) {
        expectFsError(() => listLibrary(bad, root), 400, `kind=${String(bad)}`)
      }
    })
  })
})

/* ============================================================
 * 条目名 / 路径安全
 * ============================================================ */

describe('条目名与路径安全', () => {
  test('合法名：中文 / 空格 / 括号 / 内部单点保留', () => {
    for (const name of ['base', 'StatCard', '我的样式', 'my.card', 'card compact', 'card (2)']) {
      assert.equal(validateLibraryName(name), name)
    }
    assert.equal(validateLibraryName('  base  '), 'base', '首尾空白被归一化')
  })

  test('非法名全部 400（.. / 绝对路径 / 盘符 / 分隔符 / 控制字符 / 保留名 / 带扩展名）', () => {
    const bad: unknown[] = [
      '',
      '   ',
      '..',
      '../x',
      'a/b',
      'a\\b',
      '/abs',
      'C:\\x',
      'C:/x',
      '.hidden',
      'a.',
      'CON',
      'com1',
      'my.elem.json',
      'base.uss.json',
      'formatDuration.fn.json',
      'x\u0000y',
      'x\u0001y',
      'x'.repeat(65),
      'a..b',
      42,
      null,
      undefined,
    ]
    for (const name of bad) {
      expectFsError(() => validateLibraryName(name), 400, `name=${String(name)}`)
    }
  })

  test('未知 kind 的写 / 读 / 删都 400；非法名在读 / 删入口同样被拒', () => {
    withRoot((root) => {
      expectFsError(() => writeLibraryEntry('element', 'x', '{}', root), 400, '写未知 kind')
      expectFsError(() => readLibraryEntry('elements', '../x', root), 400, '读上跳名')
      expectFsError(() => deleteLibraryEntry('styles', 'a/b', root), 400, '删斜杠名')
    })
  })

  test('跨类型访问：元素名不能当样式读 / 删（404），各类型命名空间独立', () => {
    withRoot((root) => {
      writeLibraryEntry('elements', 'Same', json({ version: 3 }), root)
      writeLibraryEntry('styles', 'Same', json({ version: 1 }), root)
      assert.equal(listLibrary('elements', root).length, 1)
      assert.equal(listLibrary('styles', root).length, 1)
      expectFsError(() => readLibraryEntry('functions', 'Same', root), 404, '函数命名空间无此条目')
      assert.equal(readLibraryEntry('elements', 'Same', root).content, json({ version: 3 }))
    })
  })

  test('libraryEntryPath 不越过库根；带 .. 的名字在拼接前被拒', () => {
    withRoot((root) => {
      const abs = libraryEntryPath('elements', 'StatCard', root)
      assert.ok(abs.startsWith(path.resolve(root) + path.sep))
      assert.equal(path.basename(abs), 'StatCard.elem.json')
      expectFsError(() => libraryEntryPath('elements', '..', root), 400, '点段')
    })
  })
})

/* ============================================================
 * CRUD
 * ============================================================ */

describe('CRUD 与快照', () => {
  test('写入 → 列表 → 读取（指纹一致）；新建不产生快照', () => {
    withRoot((root) => {
      const content = json({ version: 3, kind: 'element', name: 'StatCard' })
      const w = writeLibraryEntry('elements', 'StatCard', content, root)
      assert.equal(w.ok, true)
      assert.equal(w.created, true)
      assert.equal(w.snapshotTs, null)
      assert.equal(w.path, 'elements/StatCard.elem.json')
      assert.equal(w.size, Buffer.byteLength(content, 'utf8'))
      assert.equal(w.sha256, createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'))

      const entries = listLibrary('elements', root)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].name, 'StatCard')
      assert.equal(entries[0].size, w.size)
      assert.match(entries[0].mtime, /^\d{4}-\d{2}-\d{2}T/)

      const read = readLibraryEntry('elements', 'StatCard', root)
      assert.equal(read.ok, true)
      assert.equal(read.content, content)
      assert.equal(read.sha256, w.sha256)
      assert.equal(read.path, 'elements/StatCard.elem.json')
      assert.equal(listLibraryHistory('elements', 'StatCard', root).entries.length, 0)
    })
  })

  test('覆盖写入：created=false + 旧内容进入 .history，恢复可回退', () => {
    withRoot((root) => {
      writeLibraryEntry('styles', 'base', 'v1', root)
      const w2 = writeLibraryEntry('styles', 'base', 'v2', root)
      assert.equal(w2.created, false)
      assert.equal(typeof w2.snapshotTs, 'string')
      const history = listLibraryHistory('styles', 'base', root)
      assert.equal(history.entries.length, 1)
      assert.equal(history.entries[0].ts, w2.snapshotTs)
      assert.equal(history.entries[0].size, 2)
      const restored = restoreLibraryHistory('styles', 'base', w2.snapshotTs, root)
      assert.equal(restored.preRestoreTs === null, false, '恢复前应为当前内容留快照')
      assert.equal(readLibraryEntry('styles', 'base', root).content, 'v1')
    })
  })

  test('删除：删除前快照保留，条目消失但历史可查 / 可恢复', () => {
    withRoot((root) => {
      writeLibraryEntry('functions', 'formatDuration', 'fn-v1', root)
      const del = deleteLibraryEntry('functions', 'formatDuration', root)
      assert.equal(del.ok, true)
      assert.equal(del.name, 'formatDuration')
      assert.equal(typeof del.snapshotTs, 'string')
      assert.equal(listLibrary('functions', root).length, 0)
      expectFsError(() => readLibraryEntry('functions', 'formatDuration', root), 404, '删除后读取')
      const history = listLibraryHistory('functions', 'formatDuration', root)
      assert.equal(history.entries.length, 1)
      const restored = restoreLibraryHistory('functions', 'formatDuration', del.snapshotTs, root)
      assert.equal(restored.preRestoreTs, null, '误删恢复：当前不存在，无恢复前快照')
      assert.equal(readLibraryEntry('functions', 'formatDuration', root).content, 'fn-v1')
    })
  })

  test('改名：同类型内移动 / 冲突 409 / overwrite 覆盖（目标留快照）', () => {
    withRoot((root) => {
      writeLibraryEntry('elements', 'Old', 'old-content', root)
      const renamed = renameLibraryEntry('elements', 'Old', 'New', { root })
      assert.equal(renamed.moved, true)
      assert.equal(renamed.from, 'Old')
      assert.equal(renamed.name, 'New')
      assert.equal(renamed.path, 'elements/New.elem.json')
      expectFsError(() => readLibraryEntry('elements', 'Old', root), 404, '旧名不存在')
      assert.equal(readLibraryEntry('elements', 'New', root).content, 'old-content')

      writeLibraryEntry('elements', 'Target', 'target-content', root)
      expectFsError(
        () => renameLibraryEntry('elements', 'New', 'Target', { root }),
        409,
        '目标已存在且未覆盖',
      )
      const replaced = renameLibraryEntry('elements', 'New', 'Target', { root, overwrite: true })
      assert.equal(replaced.name, 'Target')
      assert.equal(typeof replaced.replacedSnapshotTs, 'string')
      assert.equal(readLibraryEntry('elements', 'Target', root).content, 'old-content')
      assert.equal(listLibrary('elements', root).length, 1)
      // 被覆盖目标的旧内容可从快照恢复
      const history = listLibraryHistory('elements', 'Target', root)
      assert.ok(history.entries.some((e) => e.ts === replaced.replacedSnapshotTs))
    })
  })

  test('改名：同名 no-op；仅大小写改名成功且列表只剩一个', () => {
    withRoot((root) => {
      writeLibraryEntry('styles', 'Base', 'x', root)
      const noop = renameLibraryEntry('styles', 'Base', 'Base', { root })
      assert.equal(noop.moved, false)
      const caseOnly = renameLibraryEntry('styles', 'Base', 'base', { root })
      assert.equal(caseOnly.moved, true)
      assert.equal(caseOnly.name, 'base')
      const list = listLibrary('styles', root)
      assert.equal(list.length, 1)
      assert.equal(list[0].name, 'base')
    })
  })

  test('改名 / 删除不存在的条目 → 404 中文错误', () => {
    withRoot((root) => {
      ensureLibraryRoot(root)
      expectFsError(() => renameLibraryEntry('elements', 'nope', 'x', { root }), 404, '改名源不存在')
      expectFsError(() => deleteLibraryEntry('styles', 'nope', root), 404, '删除不存在')
    })
  })

  test('content 必须为字符串；超大内容 413', () => {
    withRoot((root) => {
      expectFsError(() => writeLibraryEntry('elements', 'x', { version: 3 }, root), 400, '非字符串')
      expectFsError(
        () => writeLibraryEntry('elements', 'big', 'x'.repeat(8 * 1024 * 1024 + 1), root),
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
        writeLibraryEntry('styles', 'base', 'v1', root)
        writeLibraryEntry('styles', 'base', 'v2', root)
        writeLibraryEntry('styles', 'base', 'v3', root)
        writeLibraryEntry('styles', 'base', 'v4', root)
        const history = listLibraryHistory('styles', 'base', root)
        assert.equal(history.entries.length, 2, '上限 2 份')
        // 新 → 旧：最新快照是写 v4 前的 v3，其次 v2
        const oldest = history.entries[history.entries.length - 1]
        restoreLibraryHistory('styles', 'base', oldest.ts, root)
        assert.equal(readLibraryEntry('styles', 'base', root).content, 'v2', '最旧的 v1 已被淘汰')
      })
    })
  })

  test('非法 ts / 不存在快照 → 400 / 404', () => {
    withRoot((root) => {
      writeLibraryEntry('styles', 'base', 'v1', root)
      for (const ts of ['', '..', '../../x', '2026', '20260101-000000', 123, null]) {
        expectFsError(
          () => restoreLibraryHistory('styles', 'base', ts, root),
          400,
          `ts=${String(ts)}`,
        )
      }
      expectFsError(
        () => restoreLibraryHistory('styles', 'base', '20260101-000000-000', root),
        404,
        '快照不存在',
      )
    })
  })

  test('同毫秒多次快照产生不同 ts（字典序 = 时间序）', () => {
    withRoot((root) => {
      writeLibraryEntry('styles', 'base', 'v0', root)
      for (let i = 1; i <= 5; i++) writeLibraryEntry('styles', 'base', `v${i}`, root)
      const entries = listLibraryHistory('styles', 'base', root).entries
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

/** 造一个含依赖闭包的库：Icon ← StatCard（引用 Icon + base），另有函数 */
function seedExportLibrary(root: string): void {
  writeLibraryEntry(
    'elements',
    'StatCard',
    json({
      version: 3,
      kind: 'element',
      name: 'StatCard',
      styles: ['@library/styles/base'],
      root: { type: 'vbox', children: [{ type: '__element', element: '@library/elements/Icon' }] },
    }),
    root,
  )
  writeLibraryEntry('elements', 'Icon', json({ version: 3, kind: 'element', name: 'Icon' }), root)
  writeLibraryEntry('styles', 'base', json({ version: 1, classes: { card: {} } }), root)
  writeLibraryEntry(
    'functions',
    'formatDuration',
    json({ version: 3, kind: 'function', scope: 'global', name: 'formatDuration' }),
    root,
  )
}

describe('导出（manifest 指纹 + 依赖闭包）', () => {
  test('选中条目导出会带上 @library 依赖闭包，manifest 指纹与文件一致', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const bundle = exportLibraryBundle({ entries: [{ kind: 'elements', name: 'StatCard' }], root })
      assert.equal(bundle.ok, true)
      assert.deepEqual(
        bundle.files.map((f) => f.name),
        ['Icon', 'StatCard', 'base'],
        '元素优先、同类按名称排序；闭包含子元素与样式',
      )
      assert.deepEqual(bundle.missing, [])
      assert.equal(bundle.manifest.version, 1)
      assert.match(bundle.manifest.createdAt, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(bundle.manifest.entries.length, 3)
      for (const entry of bundle.manifest.entries) {
        const file = bundle.files.find((f) => f.kind === entry.kind && f.name === entry.name)
        assert.ok(file, `manifest 条目应有对应文件：${entry.kind}/${entry.name}`)
        assert.equal(entry.sha256, sha256Hex(file.content))
        assert.equal(entry.sha256.length, 64)
      }
    })
  })

  test('缺省/空选择：缺省 = 全部条目；[] = 空包（只有 manifest）', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const all = exportLibraryBundle({ root })
      assert.equal(all.files.length, 4)
      const empty = exportLibraryBundle({ entries: [], root })
      assert.equal(empty.files.length, 0)
      assert.equal(empty.manifest.entries.length, 0)
    })
  })

  test('显式选择不存在的条目 → 404；缺失依赖只记入 missing 不阻断导出', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      expectFsError(
        () => exportLibraryBundle({ entries: [{ kind: 'elements', name: 'Ghost' }], root }),
        404,
        '导出不存在条目',
      )
      writeLibraryEntry(
        'elements',
        'Broken',
        json({ version: 3, styles: ['@library/styles/missing-table'] }),
        root,
      )
      const bundle = exportLibraryBundle({ entries: [{ kind: 'elements', name: 'Broken' }], root })
      assert.deepEqual(bundle.missing, [{ kind: 'styles', name: 'missing-table' }])
      assert.equal(bundle.files.length, 1)
    })
  })

  test('includeDependencies=false 只导出选中条目', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const bundle = exportLibraryBundle({
        entries: [{ kind: 'elements', name: 'StatCard' }],
        includeDependencies: false,
        root,
      })
      assert.deepEqual(bundle.files.map((f) => f.name), ['StatCard'])
    })
  })

  test('zip 内含 manifest.json + <kind>/<name><ext>，且可被自身读取', () => {
    withRoot((root) => {
      seedExportLibrary(root)
      const result = exportLibraryZip({ entries: [{ kind: 'elements', name: 'StatCard' }], root })
      assert.equal(result.entryCount, 3)
      assert.ok(result.bytes > 0)
      const files = readZipArchive(result.zip)
      assert.deepEqual(
        files.map((f) => f.path),
        [
          'manifest.json',
          'elements/Icon.elem.json',
          'elements/StatCard.elem.json',
          'styles/base.uss.json',
        ],
      )
      const manifest = JSON.parse(files[0].content.toString('utf8')) as {
        version: number
        entries: Array<{ kind: string; name: string; sha256: string }>
      }
      assert.equal(manifest.version, 1)
      assert.equal(manifest.entries.length, 3)
    })
  })
})

describe('导入（zip / 冲突策略 / 安全）', () => {
  test('导出 → 导入空库往返：内容与指纹一致', () => {
    withRoot((source) => {
      seedExportLibrary(source)
      const zip = exportLibraryZip({ entries: [{ kind: 'elements', name: 'StatCard' }], root: source }).zip
      withRoot((target) => {
        const result = importLibraryZip(zip, { root: target })
        assert.equal(result.ok, true)
        assert.equal(result.policy, 'skip')
        assert.equal(result.verified, true)
        assert.deepEqual(result.summary, { created: 3, overwritten: 0, renamed: 0, skipped: 0 })
        assert.deepEqual(result.imported.map((i) => `${i.kind}/${i.name}`), [
          'elements/Icon',
          'elements/StatCard',
          'styles/base',
        ])
        for (const kind of LIBRARY_KINDS) {
          for (const entry of listLibrary(kind, target)) {
            const sourceRead = readLibraryEntry(kind, entry.name, source)
            const targetRead = readLibraryEntry(kind, entry.name, target)
            assert.equal(targetRead.sha256, sourceRead.sha256, `${kind}/${entry.name} 指纹应一致`)
          }
        }
      })
    })
  })

  test('冲突策略 skip：保留本地内容并计入 skipped', () => {
    withRoot((source) => {
      writeLibraryEntry('styles', 'base', 'imported-v1', source)
      const zip = exportLibraryZip({ root: source }).zip
      withRoot((target) => {
        writeLibraryEntry('styles', 'base', 'local-content', target)
        const result = importLibraryZip(zip, { root: target, policy: 'skip' })
        assert.equal(result.summary.skipped, 1)
        assert.equal(result.summary.created, 0)
        assert.equal(result.skipped[0].name, 'base')
        assert.match(result.skipped[0].reason, /已存在/)
        assert.equal(readLibraryEntry('styles', 'base', target).content, 'local-content')
        assert.equal(listLibraryHistory('styles', 'base', target).entries.length, 0, 'skip 不写快照')
      })
    })
  })

  test('冲突策略 overwrite：覆盖本地内容并留快照', () => {
    withRoot((source) => {
      writeLibraryEntry('styles', 'base', 'imported-v2', source)
      const zip = exportLibraryZip({ root: source }).zip
      withRoot((target) => {
        writeLibraryEntry('styles', 'base', 'local-content', target)
        const result = importLibraryZip(zip, { root: target, policy: 'overwrite' })
        assert.equal(result.summary.overwritten, 1)
        assert.equal(result.imported[0].action, 'overwritten')
        assert.equal(result.imported[0].name, 'base')
        assert.equal(readLibraryEntry('styles', 'base', target).content, 'imported-v2')
        assert.equal(listLibraryHistory('styles', 'base', target).entries.length, 1, '覆盖前快照')
      })
    })
  })

  test('冲突策略 rename：并存改名（name (2)），原条目不动', () => {
    withRoot((source) => {
      writeLibraryEntry('styles', 'base', 'imported', source)
      const zip = exportLibraryZip({ root: source }).zip
      withRoot((target) => {
        writeLibraryEntry('styles', 'base', 'local', target)
        const result = importLibraryZip(zip, { root: target, policy: 'rename' })
        assert.equal(result.summary.renamed, 1)
        assert.equal(result.imported[0].action, 'renamed')
        assert.equal(result.imported[0].to, 'base (2)')
        assert.equal(readLibraryEntry('styles', 'base', target).content, 'local')
        assert.equal(readLibraryEntry('styles', 'base (2)', target).content, 'imported')
      })
    })
  })

  test('无 manifest 的 zip 允许导入（verified=false）；重复条目 400', () => {
    withRoot((root) => {
      const noManifest = createZipArchive([
        { path: 'styles/plain.uss.json', content: Buffer.from('{}') },
      ])
      const result = importLibraryZip(noManifest, { root })
      assert.equal(result.verified, false)
      assert.equal(result.manifest, null)
      assert.equal(result.summary.created, 1)
      assert.equal(readLibraryEntry('styles', 'plain', root).content, '{}')

      const duplicate = createZipArchive([
        { path: 'styles/dup.uss.json', content: Buffer.from('{}') },
        { path: 'styles/Dup.uss.json', content: Buffer.from('{}') },
      ])
      expectFsError(() => importLibraryZip(duplicate, { root }), 400, '重复条目')
    })
  })

  test('Windows 反斜杠条目名归一化后可导入；反斜杠上跳仍被拒', () => {
    withRoot((root) => {
      const winZip = createZipArchive([
        { path: 'styles\\win.uss.json', content: Buffer.from('{}') },
      ])
      const result = importLibraryZip(winZip, { root })
      assert.equal(result.summary.created, 1)
      assert.equal(readLibraryEntry('styles', 'win', root).content, '{}')
      expectFsError(
        () =>
          importLibraryZip(
            createZipArchive([{ path: 'styles\\..\\..\\evil.uss.json', content: Buffer.from('{}') }]),
            { root },
          ),
        403,
        '反斜杠上跳',
      )
    })
  })

  test('越权 zip 路径 / 跨类型扩展名 / 保留名 → 403 / 400', () => {
    withRoot((root) => {
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: 'elements/../../evil.elem.json', content: Buffer.from('{}') }]), { root }),
        403,
        '上跳路径',
      )
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: '/elements/x.elem.json', content: Buffer.from('{}') }]), { root }),
        403,
        '绝对路径',
      )
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: 'elements/CON.elem.json', content: Buffer.from('{}') }]), { root }),
        400,
        '保留设备名',
      )
      expectFsError(
        () => importLibraryZip(createZipArchive([{ path: 'elements/x.uss.json', content: Buffer.from('{}') }]), { root }),
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
      // 篡改 StatCard 内容，保持旧 manifest
      const tampered = files.map((f) =>
        f.path === 'elements/StatCard.elem.json' ? { ...f, content: Buffer.from('{}') } : f,
      )
      withRoot((target) => {
        expectFsError(
          () => importLibraryZip(createZipArchive(tampered), { root: target }),
          400,
          '指纹不符',
        )
      })
      // manifest 列了但 zip 没给
      const manifest = JSON.parse(files[0].content.toString('utf8')) as {
        version: number
        createdAt: string
        entries: Array<{ kind: string; name: string; sha256: string }>
      }
      manifest.entries.push({ kind: 'styles', name: 'ghost', sha256: '0'.repeat(64) })
      const missingEntry = [
        { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
        ...files.slice(1),
      ]
      withRoot((target) => {
        expectFsError(
          () => importLibraryZip(createZipArchive(missingEntry), { root: target }),
          400,
          'manifest 缺条目',
        )
      })
      // zip 多出 manifest 未列的条目
      const extra = [
        ...files,
        { path: 'styles/extra.uss.json', content: Buffer.from('{}') },
      ]
      withRoot((target) => {
        expectFsError(
          () => importLibraryZip(createZipArchive(extra), { root: target }),
          400,
          '未列入 manifest',
        )
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
      { path: 'elements/我的元素.elem.json', content: Buffer.from('{}') },
      { path: 'styles/empty.uss.json', content: Buffer.alloc(0) },
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
        writeLibraryEntry('elements', 'A', 'v1', root)
        writeLibraryEntry('elements', 'A', 'v2', root)
        renameLibraryEntry('elements', 'A', 'B', { root })
        deleteLibraryEntry('elements', 'B', root)
        const history = listLibraryHistory('elements', 'B', root)
        restoreLibraryHistory('elements', 'B', history.entries[0].ts, root)
      } finally {
        stop()
      }
      assert.deepEqual(events, [
        { kind: 'elements', name: 'A', action: 'saved' },
        { kind: 'elements', name: 'A', action: 'saved' },
        { kind: 'elements', name: 'B', action: 'renamed', from: 'A' },
        { kind: 'elements', name: 'B', action: 'deleted' },
        { kind: 'elements', name: 'B', action: 'saved' },
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
      writeLibraryEntry('styles', 'base', 'v1', root)
      assert.equal(events.length, 0, '退订后不应收到事件')

      const unsubscribeThrow = onLibraryChange(() => {
        throw new Error('订阅者故意抛错')
      })
      try {
        const result = writeLibraryEntry('styles', 'base', 'v2', root)
        assert.equal(result.ok, true)
        assert.equal(readLibraryEntry('styles', 'base', root).content, 'v2')
      } finally {
        unsubscribeThrow()
      }
    })
  })

  test('import / export 只在写库时产生事件（skip 无事件）', () => {
    withRoot((source) => {
      writeLibraryEntry('styles', 'base', 'imported', source)
      const zip = exportLibraryZip({ root: source }).zip
      withRoot((target) => {
        writeLibraryEntry('styles', 'base', 'local', target)
        const events: LibraryChangeEvent[] = []
        const stop = onLibraryChange((e) => events.push(e))
        try {
          const skipped = importLibraryZip(zip, { root: target, policy: 'skip' })
          assert.equal(skipped.summary.skipped, 1)
          assert.equal(events.length, 0, 'skip 不应广播')
          importLibraryZip(zip, { root: target, policy: 'overwrite' })
          assert.deepEqual(events, [{ kind: 'styles', name: 'base', action: 'saved' }])
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
      styles: ['@library/styles/base'],
      root: { children: [{ element: '@library/elements/Icon' }, { element: '@library/elements/../evil' }] },
      fn: '@library/functions/formatDuration',
      text: 'not-a-ref',
    })
    assert.deepEqual(refs, [
      { kind: 'styles', name: 'base' },
      { kind: 'elements', name: 'Icon' },
      { kind: 'functions', name: 'formatDuration' },
    ])
  })
})
