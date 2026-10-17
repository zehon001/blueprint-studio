/**
 * Blueprint Studio v2 —— TS 转译服务（T3.3 · PLAN §9.2「TS 转译」）
 *
 * 职责：
 *  1. transpileTypeScript：esbuild transform 纯文本转译（loader ts/js → ESM JS，
 *     target es2022，experimentalDecorators 支持 @tool/@expose/@on 注解）。
 *     无路径执行、无文件 IO——content 是唯一输入，js 是唯一产物。
 *  2. 内存缓存：按 (path, content sha256) 键缓存转译产物，Map 上限 200 条 LRU 淘汰
 *     （命中即刷新新旧序）；仅缓存成功产物，失败不缓存（改错后立即可重试）。
 *  3. handleTranspileRequest：POST /api/transpile 路由处理（index.ts 追加调用），
 *     body: { path, content } 或 { source, loader? }；返回与 server 全局一致的
 *     { status, payload } 形态，payload 契约：
 *       成功      → { ok: true, js, warnings, cached }
 *       语法错误  → { ok: false, message, errors: [{ line, column, message }] }
 *     行列号 1 起（esbuild 的 line 本就 1 起、column 0 起，此处统一 +1 对齐
 *     parser-ts 诊断「行列 1 起」口径）。
 *
 * 安全边界：纯文本转换，不读盘、不执行产物；content 上限 512KB（超限 FsError 413）。
 *
 * 与运行窗口（src/runtime/binding.ts T3.3 脚本分支）的关系：运行窗口对 .ts 绑定
 * POST /api/transpile 拿「语法级诊断 + 缓存」（PLAN §9.2 转译在本地服务）；而
 * 执行 IR 一律用源码 parseScriptToIR 解析（D3 单一 IR 路径）——转译产物留给
 * 将来「直接执行」模式与脚本编辑器诊断使用。
 */
import { createHash } from 'node:crypto'
import { transform as esbuildTransform } from 'esbuild'
import { FsError } from './fs'

/* ============================================================
 * 契约
 * ============================================================ */

/** 转译输入大小上限（512KB；超限拒绝，防误传大文件） */
export const TRANSPILE_MAX_BYTES = 512 * 1024

/** 转译缓存条目上限（LRU 淘汰最旧） */
export const TRANSPILE_CACHE_LIMIT = 200

/** 转译诊断（行列 1 起，与 parser-ts ParseDiagnostic 同口径） */
export interface TranspileDiag {
  /** 行号（1 起） */
  line: number;
  /** 列号（1 起） */
  column: number;
  /** 中文 / 原文错误说明 */
  message: string;
}

/** transpileTypeScript 结果（不抛转译级错误；语法错误以 ok:false + errors 返回） */
export interface TranspileResult {
  /** true = 转译成功（js 可用）；false = 语法错误（errors 可用） */
  ok: boolean;
  /** 转译产物 JS（ok=true 时存在） */
  js?: string;
  /** esbuild 警告（ok=true 时可能非空；行列 1 起） */
  warnings?: TranspileDiag[];
  /** 语法 / 转换错误（ok=false 时存在；行列 1 起） */
  errors?: TranspileDiag[];
  /** 失败摘要（ok=false 时存在，便于调用方一行展示） */
  message?: string;
  /** 本次是否命中缓存（测试与调试用） */
  cached?: boolean;
}

/** transpileTypeScript 选项 */
export interface TranspileOptions {
  /**
   * 项目内路径（仅作缓存键与归属标识，不参与转换、不落盘、不执行）；
   * 缺省空串（{ source } 形态即按纯内容哈希键）。
   */
  path?: string;
  /** esbuild loader（缺省 'ts'；本服务只面向受控子集脚本，'js' 仅作透传兜底） */
  loader?: 'ts' | 'js';
  /** esbuild transform 替身（单测计数用；缺省真 esbuild.transform） */
  transformFn?: typeof esbuildTransform;
}

/* ============================================================
 * 缓存（LRU：Map 插入序即新旧序，命中重插、超限删首）
 * ============================================================ */

/** 缓存键：path 与内容哈希双段（同内容不同路径各自成条，符合「(path, content hash) 键」约定） */
function cacheKeyOf(path: string, content: string): string {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex')
  return `${path}\u0000${hash}`
}

/** 转译产物缓存（进程内存级；服务重启即清空，无需持久化） */
const transpileCache = new Map<string, TranspileResult>()

/** 当前缓存条数（观测 / 测试用） */
export function transpileCacheSize(): number {
  return transpileCache.size
}

/** 清空转译缓存（测试用；生产无需调用） */
export function clearTranspileCache(): void {
  transpileCache.clear()
}

/* ============================================================
 * 转译核心
 * ============================================================ */

/** esbuild Message → TranspileDiag（行列统一 1 起；无位置的归到 1:1） */
function mapDiags(messages: readonly { text?: string; location?: { line?: number; column?: number } | null }[]): TranspileDiag[] {
  return messages.map((m) => ({
    line: m.location?.line ?? 1,
    column: (m.location?.column ?? 0) + 1, // esbuild column 0 起 → 统一 1 起
    message: m.text ?? '未知错误',
  }));
}

/**
 * TS 源码 → 转译 JS（type-strip）+ 诊断。语法错误不抛中断，以 ok:false + errors 返回
 * （行列 1 起）；仅内容级异常（超限）抛 FsError 交由 HTTP 层映射状态码。
 */
export async function transpileTypeScript(content: string, opts: TranspileOptions = {}): Promise<TranspileResult> {
  if (Buffer.byteLength(content, 'utf8') > TRANSPILE_MAX_BYTES) {
    throw new FsError(413, `转译内容过大（上限 ${Math.floor(TRANSPILE_MAX_BYTES / 1024)}KB）`)
  }
  const loader = opts.loader ?? 'ts'
  const key = cacheKeyOf(opts.path ?? '', content)

  /* 缓存命中：重插刷新 LRU 新旧序后直接返回 */
  const hit = transpileCache.get(key)
  if (hit) {
    transpileCache.delete(key)
    transpileCache.set(key, hit)
    return { ...hit, cached: true }
  }

  /* 真转换：esbuild transform（受控子集含装饰器 → experimentalDecorators） */
  const transformFn = opts.transformFn ?? esbuildTransform
  let result: TranspileResult
  try {
    const r = await transformFn(content, {
      loader,
      format: 'esm',
      target: 'es2022',
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    })
    result = { ok: true, js: r.code, warnings: mapDiags(r.warnings) }
  } catch (err) {
    // esbuild 语法 / 转换错误：Error.errors 带 location（line 1 起、column 0 起）
    const errs = (err as { errors?: { text?: string; location?: { line?: number; column?: number } | null }[] }).errors
    if (!Array.isArray(errs) || errs.length === 0) throw err // 非转译级异常（调用方 bug 等）原样上抛
    const diags = mapDiags(errs)
    result = {
      ok: false,
      errors: diags,
      message: `TS 转译失败（${diags.length} 处）：${diags.map((d) => `第 ${d.line} 行第 ${d.column} 列 ${d.message}`).join('；')}`,
    }
    return result // 失败不进缓存
  }

  /* 成功产物入缓存；超限按 LRU 淘汰最旧（Map 首键） */
  transpileCache.set(key, result)
  while (transpileCache.size > TRANSPILE_CACHE_LIMIT) {
    const oldest = transpileCache.keys().next().value
    if (oldest === undefined) break
    transpileCache.delete(oldest)
  }
  return { ...result, cached: false }
}

/* ============================================================
 * HTTP 路由处理（index.ts：POST /api/transpile）
 * ============================================================ */

/** 路由处理结果（与 server/plugins/registry.ts PluginRouteResult 同形） */
export interface TranspileRouteResult {
  status: number
  payload: unknown
}

/**
 * POST /api/transpile 请求体处理：
 *  - { path: string, content: string } —— 项目内路径 + 源码（运行窗口 / 保存链路形态）
 *  - { source: string, loader?: 'ts' } —— 纯源码形态（无缓存归属路径，按 '' 键）
 * 参数缺失 / 超限抛 FsError（index.ts 统一映射 400/413 + { ok:false, message }）；
 * 语法错误不算 HTTP 错误（200 + ok:false + errors——转译结果本身就是资源表述）。
 */
export async function handleTranspileRequest(body: unknown): Promise<TranspileRouteResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FsError(400, '请求体应为 JSON 对象')
  }
  const b = body as Record<string, unknown>
  const content = typeof b.content === 'string' ? b.content : typeof b.source === 'string' ? b.source : null
  if (content === null) {
    throw new FsError(400, '缺少 content（或 source）字段：应为脚本源码字符串')
  }
  if (b.path !== undefined && typeof b.path !== 'string') {
    throw new FsError(400, 'path 字段应为字符串（项目内相对路径，仅作缓存键）')
  }
  const loader = b.loader ?? 'ts'
  if (loader !== 'ts' && loader !== 'js') {
    throw new FsError(400, `loader 仅支持 'ts' / 'js'（收到：${String(loader)}）`)
  }
  const result = await transpileTypeScript(content, { path: b.path ?? '', loader })
  if (result.ok) {
    return { status: 200, payload: { ok: true, js: result.js, warnings: result.warnings, cached: result.cached } }
  }
  return { status: 200, payload: { ok: false, message: result.message, errors: result.errors } }
}
