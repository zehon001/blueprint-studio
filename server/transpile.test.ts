/**
 * TS 转译服务测试（T3.3 · 任务卡单测清单 1）
 *
 * 1. 合法 TS（含装饰器）转译出 JS（experimentalDecorators 生效：装饰器降级为
 *    __decorateClass 运行时辅助，类型注解被剥离）
 * 2. 语法错误返回行列（esbuild 错误位置解析；行列统一 1 起）
 * 3. 缓存命中：同 (path, content) 二次调用不重复 transform（计数断言）；
 *    不同内容 / 不同路径各自成条
 * 4. LRU 淘汰：上限 200 条，命中刷新新旧序（touch p0 后再插入，淘汰的是 p1 而非 p0）
 * 5. handleTranspileRequest：{ path, content } / { source } 两种形态；缺字段 / 非法
 *    loader → FsError 400；超限 → FsError 413；纯文本转换（path 只是缓存键，不做路径处理）
 *
 * 运行：npx tsx --test server/transpile.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { transform as realTransform } from 'esbuild'
import {
  TRANSPILE_CACHE_LIMIT,
  TRANSPILE_MAX_BYTES,
  clearTranspileCache,
  handleTranspileRequest,
  transpileCacheSize,
  transpileTypeScript,
} from './transpile'
import { FsError } from './fs'

/* ============================================================
 * 工具
 * ============================================================ */

/** 带装饰器的合法 TS 样本（受控子集形态：@tool / @expose / @on） */
const VALID_TS = `@tool('计数器')
class Counter {
  @expose({ type: 'number', default: 0 })
  count: number

  @on('start')
  onStart(): void {
    print('started')
  }
}
`

/** 计数 transform 替身：记录每次真实 transform 的输入（缓存命中等价于不再追加） */
function countingTransform() {
  const calls: string[] = []
  const fn = ((code: string, options?: Parameters<typeof realTransform>[1]) => {
    calls.push(code)
    return realTransform(code, options)
  }) as typeof realTransform
  return { fn, calls }
}

/** FsError 断言（assert.rejects 的校验器） */
function fsErrorOf(status: number, label: string): (err: unknown) => boolean {
  return (err) => {
    if (!(err instanceof FsError)) return false
    assert.equal(err.status, status, label)
    return true
  }
}

/* ══ 1. 合法 TS（含装饰器）→ JS ═══════════════════════════ */

describe('transpileTypeScript：合法 TS 转译', () => {
  test('装饰器降级为 __decorateClass（experimentalDecorators），类型注解剥离，无警告', async () => {
    clearTranspileCache()
    const r = await transpileTypeScript(VALID_TS, { path: 'logic/counter.ts' })
    assert.equal(r.ok, true)
    assert.equal(r.cached, false)
    assert.ok(typeof r.js === 'string' && r.js.length > 0, '产出非空 JS')
    assert.ok(r.js!.includes('__decorateClass'), 'experimentalDecorators 生效（类装饰器降级辅助）')
    assert.ok(r.js!.includes('on("start")'), '方法装饰器参数保留')
    assert.ok(!r.js!.includes(': number'), '类型注解被剥离（type-strip）')
    assert.ok(r.js!.includes('class'), '类结构保留')
    assert.deepEqual(r.warnings, [], '合法样本无警告')
  })

  test('转译产物是合法 ESM（format=esm + target=es2022：顶层形态可直接解析）', async () => {
    clearTranspileCache()
    const r = await transpileTypeScript('export const answer: number = 42\n', { path: 'a.ts' })
    assert.equal(r.ok, true)
    assert.ok(r.js!.includes('export'), '保留 ESM export（format=esm）')
  })
})

/* ══ 2. 语法错误 → 行列诊断 ═══════════════════════════════ */

describe('transpileTypeScript：语法错误', () => {
  test('错误带行列（1 起）与消息，不抛中断', async () => {
    clearTranspileCache()
    const r = await transpileTypeScript('const ok = 1\nconst bad = ;\n', { path: 'logic/broken.ts' })
    assert.equal(r.ok, false)
    assert.equal(r.js, undefined, '失败无产物')
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, 'errors 非空')
    const first = r.errors![0]!
    assert.equal(first.line, 2, '行号 1 起（第二行）')
    assert.ok(first.column >= 1, '列号 1 起')
    assert.ok(first.message.length > 0, '错误消息非空')
    assert.ok(r.message!.includes('TS 转译失败'), '摘要行说明失败')
  })

  test('失败不进缓存：同内容重试仍会真正 transform（修好立即可用）', async () => {
    clearTranspileCache()
    const { fn, calls } = countingTransform()
    await transpileTypeScript('const bad = ;', { path: 'x.ts', transformFn: fn })
    assert.equal(calls.length, 1)
    await transpileTypeScript('const bad = ;', { path: 'x.ts', transformFn: fn })
    assert.equal(calls.length, 2, '失败结果不缓存，二次调用重新转换')
  })
})

/* ══ 3. 缓存命中（不重复 transform）═══════════════════════ */

describe('transpileTypeScript：缓存', () => {
  test('同 (path, content) 二次调用命中缓存，不重复 transform', async () => {
    clearTranspileCache()
    const { fn, calls } = countingTransform()
    const first = await transpileTypeScript(VALID_TS, { path: 'logic/a.ts', transformFn: fn })
    assert.equal(calls.length, 1)
    assert.equal(first.cached, false)
    const second = await transpileTypeScript(VALID_TS, { path: 'logic/a.ts', transformFn: fn })
    assert.equal(calls.length, 1, '同键二次调用未再 transform（缓存命中）')
    assert.equal(second.cached, true)
    assert.equal(second.js, first.js, '命中返回同一产物')
  })

  test('缓存键含 path：同内容不同路径各自成条', async () => {
    clearTranspileCache()
    const { fn, calls } = countingTransform()
    await transpileTypeScript(VALID_TS, { path: 'logic/a.ts', transformFn: fn })
    await transpileTypeScript(VALID_TS, { path: 'logic/b.ts', transformFn: fn })
    assert.equal(calls.length, 2, '路径不同 → 键不同 → 各转一次')
    await transpileTypeScript(VALID_TS, { path: 'logic/a.ts', transformFn: fn })
    assert.equal(calls.length, 2, '原路径仍命中')
  })

  test('内容变化 → 缓存未命中（改代码立即重新转译）', async () => {
    clearTranspileCache()
    const { fn, calls } = countingTransform()
    await transpileTypeScript('const a = 1\n', { path: 'a.ts', transformFn: fn })
    await transpileTypeScript('const a = 2\n', { path: 'a.ts', transformFn: fn })
    assert.equal(calls.length, 2, '内容哈希不同 → 重新转换')
  })
})

/* ══ 4. LRU 淘汰 ══════════════════════════════════════════ */

describe('transpileTypeScript：LRU 淘汰', () => {
  test(`上限 ${TRANSPILE_CACHE_LIMIT} 条；命中刷新新旧序（被 touch 的最旧条目存活）`, async () => {
    clearTranspileCache()
    const { fn, calls } = countingTransform()
    const code = 'const v = 1\n'
    // 填满 200 条（p0..p199）
    for (let i = 0; i < TRANSPILE_CACHE_LIMIT; i++) {
      await transpileTypeScript(code, { path: `p${i}`, transformFn: fn })
    }
    assert.equal(transpileCacheSize(), TRANSPILE_CACHE_LIMIT)
    assert.equal(calls.length, TRANSPILE_CACHE_LIMIT)
    // touch p0：命中并刷新为最新
    await transpileTypeScript(code, { path: 'p0', transformFn: fn })
    assert.equal(calls.length, TRANSPILE_CACHE_LIMIT, 'touch 命中不转换')
    // 再插入 1 条 → 淘汰最旧（此时最旧是 p1，而非被 touch 的 p0）
    await transpileTypeScript(code, { path: 'p200', transformFn: fn })
    assert.equal(transpileCacheSize(), TRANSPILE_CACHE_LIMIT, '超限后条数不增长')
    assert.equal(calls.length, TRANSPILE_CACHE_LIMIT + 1)
    // p0 应仍在缓存（LRU 而非 FIFO）；p1 应已被淘汰
    await transpileTypeScript(code, { path: 'p0', transformFn: fn })
    assert.equal(calls.length, TRANSPILE_CACHE_LIMIT + 1, 'p0 被 touch 过 → 存活')
    await transpileTypeScript(code, { path: 'p1', transformFn: fn })
    assert.equal(calls.length, TRANSPILE_CACHE_LIMIT + 2, 'p1 未被 touch → 已淘汰，重新转换')
  })
})

/* ══ 5. HTTP 路由处理 ═════════════════════════════════════ */

describe('handleTranspileRequest：POST /api/transpile 请求体', () => {
  test('{ path, content } 形态：200 + { ok, js, warnings, cached }', async () => {
    clearTranspileCache()
    const r = await handleTranspileRequest({ path: 'logic/a.ts', content: VALID_TS })
    assert.equal(r.status, 200)
    const payload = r.payload as { ok: boolean; js: string; warnings: unknown[]; cached: boolean }
    assert.equal(payload.ok, true)
    assert.ok(payload.js.includes('__decorateClass'))
    assert.deepEqual(payload.warnings, [])
    assert.equal(payload.cached, false)
  })

  test('{ source, loader } 形态（缺省 loader=ts）与 path 缺省（纯内容键）', async () => {
    clearTranspileCache()
    const r = await handleTranspileRequest({ source: 'const x: number = 1\n' })
    assert.equal(r.status, 200)
    assert.equal((r.payload as { ok: boolean }).ok, true)
    // 再发一次同 source（无 path）→ 命中 '' 键缓存
    const r2 = await handleTranspileRequest({ source: 'const x: number = 1\n' })
    assert.equal((r2.payload as { cached: boolean }).cached, true)
  })

  test('语法错误：200 + { ok:false, message, errors:[{line,column,message}] }', async () => {
    clearTranspileCache()
    const r = await handleTranspileRequest({ path: 'b.ts', content: 'const bad = ;\n' })
    assert.equal(r.status, 200, '转译失败是结果而非 HTTP 错误')
    const payload = r.payload as { ok: boolean; errors: { line: number; column: number; message: string }[] }
    assert.equal(payload.ok, false)
    assert.ok(payload.errors.length > 0 && payload.errors[0]!.line >= 1 && payload.errors[0]!.column >= 1)
  })

  test('缺 content / source → FsError 400；非法 loader → FsError 400', async () => {
    await assert.rejects(handleTranspileRequest({ path: 'a.ts' }), fsErrorOf(400, '缺字段'))
    await assert.rejects(handleTranspileRequest({ source: 'x', loader: 'py' }), fsErrorOf(400, '非法 loader'))
  })

  test('content 超过 512KB → FsError 413（核心函数同样拒绝）', async () => {
    const big = `const s = '${'x'.repeat(TRANSPILE_MAX_BYTES)}'\n` // > 512KB
    await assert.rejects(handleTranspileRequest({ path: 'big.ts', content: big }), fsErrorOf(413, 'HTTP 层'))
    await assert.rejects(transpileTypeScript(big), fsErrorOf(413, '核心函数'))
    // 边界内（512KB 减去模板开销）可通过
    const okBig = `const s = '${'x'.repeat(TRANSPILE_MAX_BYTES - 64)}'\n`
    const r = await handleTranspileRequest({ path: 'big2.ts', content: okBig })
    assert.equal((r.payload as { ok: boolean }).ok, true)
  })

  test('纯文本转换安全性：path 不做路径处理（任意字符串仅作缓存键），无文件副作用', async () => {
    clearTranspileCache()
    const r = await handleTranspileRequest({ path: '../../etc/passwd', content: 'const a = 1\n' })
    assert.equal((r.payload as { ok: boolean }).ok, true, '路径形状不影响转译（不读盘不执行）')
  })
})
