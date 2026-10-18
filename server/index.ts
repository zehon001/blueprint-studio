/**
 * Blueprint Studio v2 —— 本地服务入口（T0.2 · Server-Agent）
 *
 * 职责：
 *  - REST：/api/projects（列表/新建）· /api/tree · /api/file（GET/PUT/DELETE）·
 *          /api/move · /api/import · /api/history（T7.4 快照列表）/api/history/restore（恢复）·
 *          /api/watch（SSE）· /api/health
 *  - 资源库（T11.4/T11.6，实现见 ./library.ts；独立安全根 BP_LIBRARY_ROOT）：
 *          /api/library/list · read · write · delete · rename · history · restore ·
 *          export（zip / json）· import（zip / zipBase64）· watch（SSE，PLAN §7.6）
 *  - TS 转译（T3.3）：/api/transpile（esbuild type-strip + (path, 内容哈希) LRU 缓存）
 *  - 插件注册表（T6.1）：/api/plugins（三源合并清单）· /api/plugins/:id（单清单详情）
 *  - 静态托管 dist/（多入口：/ · /editor.html · /runtime.html；SPA fallback 仅对已知入口）
 *  - CORS：放行 5173 开发跨域（localhost / 127.0.0.1）
 *  - WS Hub（T5.4）：/ws 调试观察正式协议（debug.v1，路由转发见 ./ws.ts）
 *
 * 明确不做（后续卡，留扩展点）：插件执行与 CLI 桥（T6.3）。
 *  - esbuild 转译（T3.3）已由本文件 /api/transpile + ./transpile.ts 承接；
 *  - .history 自动快照（T7.4）已由本文件 /api/history* + ./fs.ts 快照机制承接。
 *
 * 错误格式统一：成功 { ok: true, ... }；失败 { ok: false, message }。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as fsApi from './fs'
import * as libraryApi from './library'
import * as pluginsApi from './plugins/registry'
import * as executorApi from './plugins/executor'
import * as transpileApi from './transpile'
import { WsDebugHub } from './ws'

const PORT = Number(process.env.PORT || 8790)
const PROJECTS_ROOT = fsApi.ensureProjectsRoot()
// T11.4/T11.6：资源库独立安全根（默认 %USERPROFILE%\.blueprint-studio\library，BP_LIBRARY_ROOT 覆盖）。
// 启动即校验存在/可写/不与项目根重叠；每次库操作内部会再校验（PLAN §3.5）。
const LIBRARY_ROOT = libraryApi.ensureLibraryRoot()
const DIST_DIR = path.join(fsApi.repoRoot(), 'dist')
const BODY_LIMIT_BYTES = 20 * 1024 * 1024
const STARTED_AT = Date.now()

/** 开发跨域白名单（vite dev 端口 5173） */
const CORS_ORIGINS: ReadonlySet<string> = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

/**
 * 多入口静态路由：精确文件不存在时仅对这些已知入口做 fallback（不做通用 SPA fallback）。
 * /editor 与 /runtime 为无扩展名别名（运行窗口 URL 更友好）。
 */
const SPA_ENTRIES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/editor': 'editor.html',
  '/editor.html': 'editor.html',
  '/runtime': 'runtime.html',
  '/runtime.html': 'runtime.html',
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
}

/* ============================================================
 * HTTP 基础设施
 * ============================================================ */

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读取请求体原始字节（上传 zip 用；沿用 20MB 上限） */
async function readRawBody(req: IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new fsApi.FsError(413, '请求体过大（>20MB）')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readRawBody(req)).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new fsApi.FsError(400, '请求体不是合法 JSON')
  }
}

/** 二进制响应（zip 导出）：JSON 契约不适用，错误仍走 { ok:false, message } */
function sendZip(res: ServerResponse, filename: string, zip: Buffer, manifest: unknown): void {
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Expose-Headers': 'Content-Disposition, X-Library-Manifest',
    'Cache-Control': 'no-store',
  }
  // 供客户端不落盘即读 manifest（URL 编码，避免非 ASCII 头非法）；
  // 条目很多时该头可能超过常见 8KB 头限制，此时省略（manifest 仍在包内）。
  const encodedManifest = encodeURIComponent(JSON.stringify(manifest))
  if (encodedManifest.length <= 8000) headers['X-Library-Manifest'] = encodedManifest
  res.writeHead(200, headers)
  res.end(zip)
}

/** 导入的 zipBase64 解码（严格校验，避免 Buffer.from 静默忽略非法字符） */
function decodeZipBase64(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new fsApi.FsError(400, '导入需要 zip：Content-Type: application/zip 请求体，或 JSON { zipBase64 }')
  }
  const text = raw.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new fsApi.FsError(400, 'zipBase64 不是合法的 base64')
  }
  // 容忍省略 padding 的 base64（部分客户端 btoa 替代实现会去掉尾部 =）
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4)
  if (padded.length % 4 !== 0) throw new fsApi.FsError(400, 'zipBase64 长度非法')
  const buf = Buffer.from(padded, 'base64')
  if (buf.length < 22) throw new fsApi.FsError(400, 'zipBase64 内容过短（不是合法 zip）')
  return buf
}

/** 压缩包默认文件名（时间戳到秒，避免客户端同名覆盖） */
function zipFilename(): string {
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `blueprint-library-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.zip`
}

/* ============================================================
 * 请求路由
 * ============================================================ */

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((err) => {
    // 兜底：响应头已发出（如 SSE）时只能断开连接
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : String(err) })
    } else {
      res.destroy()
    }
  })
})

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const pathname = url.pathname
  applyCors(req, res)
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        name: 'blueprint-studio-server',
        version: fsApi.ENGINE_VERSION,
        projectsRoot: PROJECTS_ROOT,
        // T5.4：参与调试观察的 WS 连接数（订阅者 + 生产者去重）
        wsClients: wsHub.stats().connections,
        wsHub: wsHub.stats(),
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      })
      return
    }

    if (pathname === '/api/projects' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, root: PROJECTS_ROOT, projects: fsApi.listProjects(PROJECTS_ROOT) })
      return
    }

    if (pathname === '/api/projects' && req.method === 'POST') {
      const body = await readJson(req)
      const project = fsApi.createProject(PROJECTS_ROOT, body.name, body.template)
      sendJson(res, 201, { ok: true, project })
      return
    }

    if (pathname === '/api/tree' && req.method === 'GET') {
      const tree = fsApi.readTree(PROJECTS_ROOT, url.searchParams.get('path') ?? '')
      sendJson(res, 200, { ok: true, tree })
      return
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      sendJson(res, 200, fsApi.readFileSafe(PROJECTS_ROOT, url.searchParams.get('path') ?? ''))
      return
    }

    if (pathname === '/api/file' && req.method === 'PUT') {
      const body = await readJson(req)
      // ok 字段统一：客户端（事件面板挂载 / 检视器新建 / 保存为预制体 / 三处保存）
      // 均按 { ok: boolean } 判定成败，与 GET /api/tree 等路由的 { ok: true, ... } 同约定
      sendJson(res, 200, { ok: true, ...fsApi.writeFileSafe(PROJECTS_ROOT, body.path, body.content) })
      return
    }

    if (pathname === '/api/file' && req.method === 'DELETE') {
      sendJson(res, 200, { ok: true, ...fsApi.deletePathSafe(PROJECTS_ROOT, url.searchParams.get('path') ?? '') })
      return
    }

    // T7.4 .history 自动快照：列出项目内某文件的全部快照（新 → 旧）。
    // path 约定与 /api/file 一致（相对安全根、首段 = 项目文件夹名）；文件已删除也可查（误删恢复）。
    if (pathname === '/api/history' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...fsApi.listHistory(PROJECTS_ROOT, url.searchParams.get('path') ?? '') })
      return
    }

    // T7.4：按快照恢复（body: { path, ts }）；恢复前服务端自动为当前文件留一份快照（可撤销）。
    if (pathname === '/api/history/restore' && req.method === 'POST') {
      const body = await readJson(req)
      const relPath = typeof body.path === 'string' ? body.path : ''
      sendJson(res, 200, fsApi.restoreHistory(PROJECTS_ROOT, relPath, body.ts))
      return
    }

    if (pathname === '/api/move' && req.method === 'POST') {
      const body = await readJson(req)
      sendJson(res, 200, { ok: true, ...fsApi.movePath(PROJECTS_ROOT, body) })
      return
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      const body = await readJson(req)
      sendJson(res, 200, fsApi.importIntoProject(PROJECTS_ROOT, body.targetDir, body.sourcePath))
      return
    }

    // T0.6 项目管理器：整文件夹导入为新项目（body: { sourcePath, name? }）
    if (pathname === '/api/projects/import-folder' && req.method === 'POST') {
      const body = await readJson(req)
      const result = fsApi.importProjectFolder(PROJECTS_ROOT, body.sourcePath, body.name)
      sendJson(res, 201, result)
      return
    }

    /* ---------- T11.4 / T11.6 资源库（独立安全根；实现见 ./library.ts） ----------
     * 全部 CRUD 走同一套参数/错误契约：成功 { ok:true, ... }、失败 { ok:false, message }；
     * 路径越界 / 非法名 / 跨类型由 library.ts 抛 FsError（400/403/404/409/413/500）。
     * 库变更经 /api/library/watch（SSE）广播 { kind, name, action }（PLAN §7.6）。
     */
    // v3 D9/T11.4：库根设置（前端 bps.settings.v1 → 服务端运行时生效）
    if (pathname === '/api/library/root' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, root: libraryApi.libraryRoot() })
      return
    }
    if (pathname === '/api/library/root' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readJson(req)
      const raw = typeof body.root === 'string' ? body.root.trim() : ''
      if (raw === '') {
        // 空 = 回落默认库根
        delete process.env.BP_LIBRARY_ROOT
        const root = libraryApi.libraryRoot()
        libraryApi.ensureLibraryRoot(root)
        sendJson(res, 200, { ok: true, root })
        return
      }
      if (!path.isAbsolute(raw) || /[\u0000-\u001f]/.test(raw)) {
        sendJson(res, 400, { ok: false, message: '库根必须是绝对路径且不含控制字符' })
        return
      }
      const root = libraryApi.ensureLibraryRoot(raw)
      process.env.BP_LIBRARY_ROOT = root
      sendJson(res, 200, { ok: true, root })
      return
    }

    if (pathname === '/api/library/list' && req.method === 'GET') {
      const kind = url.searchParams.get('kind') ?? ''
      sendJson(res, 200, {
        ok: true,
        kind: libraryApi.normalizeLibraryKind(kind),
        entries: libraryApi.listLibrary(kind),
      })
      return
    }

    if (pathname === '/api/library/read' && req.method === 'GET') {
      sendJson(
        res,
        200,
        libraryApi.readLibraryEntry(url.searchParams.get('kind') ?? '', url.searchParams.get('name') ?? ''),
      )
      return
    }

    if (pathname === '/api/library/write' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readJson(req)
      sendJson(res, 200, libraryApi.writeLibraryEntry(body.kind, body.name, body.content))
      return
    }

    if (pathname === '/api/library/delete' && (req.method === 'DELETE' || req.method === 'POST')) {
      let kind = url.searchParams.get('kind')
      let name = url.searchParams.get('name')
      if (req.method === 'POST' && (!kind || !name)) {
        const body = await readJson(req)
        kind = kind ?? (typeof body.kind === 'string' ? body.kind : null)
        name = name ?? (typeof body.name === 'string' ? body.name : null)
      }
      sendJson(res, 200, libraryApi.deleteLibraryEntry(kind ?? '', name ?? ''))
      return
    }

    if (pathname === '/api/library/rename' && req.method === 'POST') {
      const body = await readJson(req)
      const from = body.from ?? body.name
      sendJson(
        res,
        200,
        libraryApi.renameLibraryEntry(body.kind, from, body.to, { overwrite: body.overwrite === true }),
      )
      return
    }

    if (pathname === '/api/library/history' && req.method === 'GET') {
      sendJson(
        res,
        200,
        libraryApi.listLibraryHistory(
          url.searchParams.get('kind') ?? '',
          url.searchParams.get('name') ?? '',
        ),
      )
      return
    }

    if (pathname === '/api/library/restore' && req.method === 'POST') {
      const body = await readJson(req)
      sendJson(res, 200, libraryApi.restoreLibraryHistory(body.kind, body.name, body.ts))
      return
    }

    // 导出：默认 zip 二进制（manifest.json 在包内 + X-Library-Manifest 头）；
    // format=json 返回 { ok:true, manifest, missing, files:[{ ..., contentBase64 }] } 供调试/测试。
    if (pathname === '/api/library/export' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJson(req) : {}
      const qKind = url.searchParams.get('kind')
      const qName = url.searchParams.get('name')
      let entries: unknown = body.entries
      if (entries === undefined && (qKind || qName)) {
        if (!qKind || !qName) throw new fsApi.FsError(400, 'export 的 kind 与 name 必须同时提供')
        entries = [{ kind: qKind, name: qName }]
      }
      const depsParam = url.searchParams.get('deps')
      const includeDependencies =
        body.includeDependencies === undefined ? depsParam !== '0' : body.includeDependencies
      const format = String(body.format ?? url.searchParams.get('format') ?? 'zip')
      if (format === 'json') {
        const bundle = libraryApi.exportLibraryBundle({ entries, includeDependencies })
        sendJson(res, 200, {
          ok: true,
          manifest: bundle.manifest,
          missing: bundle.missing,
          files: bundle.files.map((f) => ({
            kind: f.kind,
            name: f.name,
            path: f.path,
            size: f.size,
            sha256: f.sha256,
            contentBase64: f.content.toString('base64'),
          })),
        })
        return
      }
      if (format !== 'zip') throw new fsApi.FsError(400, 'format 必须为 zip | json')
      const result = libraryApi.exportLibraryZip({ entries, includeDependencies })
      sendZip(res, zipFilename(), result.zip, result.manifest)
      return
    }

    // 导入：Content-Type: application/zip（原始 zip）或 JSON { zipBase64, policy? }；
    // 冲突策略可放 query ?policy= 或 body.policy（skip | overwrite | rename，缺省 skip）。
    if (pathname === '/api/library/import' && req.method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      let policy: unknown = url.searchParams.get('policy') ?? undefined
      let zip: Buffer
      if (contentType.includes('application/zip') || contentType.includes('application/octet-stream')) {
        zip = await readRawBody(req)
      } else {
        const body = await readJson(req)
        if (policy === undefined) policy = body.policy
        zip = decodeZipBase64(body.zipBase64 ?? body.zip)
      }
      sendJson(res, 200, libraryApi.importLibraryZip(zip, { policy }))
      return
    }

    if (pathname === '/api/library/watch' && req.method === 'GET') {
      handleLibraryWatch(req, res)
      return
    }

    if (pathname === '/api/watch' && req.method === 'GET') {
      handleWatch(req, res, url.searchParams.get('path') ?? '')
      return
    }

    // T3.3 TS 转译：POST /api/transpile（body: { path, content } 或 { source, loader }）。
    // esbuild type-strip 纯文本转换（无路径执行、无文件 IO），(path, 内容哈希) LRU 缓存；
    // 语法错误返回 200 + { ok:false, errors:[{line,column,message}] }（参数/超限走 FsError 统一映射）。
    if (pathname === '/api/transpile' && req.method === 'POST') {
      const body = await readJson(req)
      const result = await transpileApi.handleTranspileRequest(body)
      sendJson(res, result.status, result.payload)
      return
    }

    // T6.3/T6.5 插件执行器（server/plugins/executor.ts，仅追加）：
    //   POST /api/plugins/invoke                              → JSON（通用通道 / phone-log / feishu-cli）
    //   POST|GET /api/plugins/:id/detect?project=&cmdOverride= → JSON（检测）
    //   GET /api/plugins/:id/install?project=&action=&cmdOverride= → SSE（安装/更新流）
    // 注意：须在下方 T6.1 注册表路由**之前**匹配——否则 GET /api/plugins/:id/detect
    // 会被注册表的 /api/plugins/:id 处理器先行 404。
    const executorHandled = await executorApi.handleExecutorRequest({
      req,
      res,
      pathname,
      query: url.searchParams,
      projectsRoot: PROJECTS_ROOT,
      readJson,
      sendJson,
    })
    if (executorHandled) return

    // T6.1 插件注册表：GET /api/plugins?project=<项目>（三源合并清单，project 缺省 = 内置+静态目录）、
    // GET /api/plugins/:id?project=（单清单详情，含节点）。检测/安装/更新执行器属 T6.3，
    // 届时在 server/plugins/executor.ts 实现并在此追加 POST /api/plugins/:id/detect|install|update。
    const pluginsResult = await pluginsApi.handlePluginsRequest(
      req.method ?? 'GET',
      pathname,
      url.searchParams,
      PROJECTS_ROOT,
    )
    if (pluginsResult) {
      sendJson(res, pluginsResult.status, pluginsResult.payload)
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, message: `未知 API：${req.method} ${pathname}` })
      return
    }

    if (req.method === 'GET') {
      serveStatic(pathname, res)
      return
    }

    sendJson(res, 404, { ok: false, message: 'Not Found' })
  } catch (err) {
    if (err instanceof fsApi.FsError) {
      if (!res.headersSent) sendJson(res, err.status, { ok: false, message: err.message })
      return
    }
    throw err
  }
}

/* ============================================================
 * 文件监视（SSE：text/event-stream，不引依赖）
 * ============================================================ */

function handleWatch(req: IncomingMessage, res: ServerResponse, relPath: string): void {
  const scope = fsApi.resolveProjectScoped(PROJECTS_ROOT, relPath)
  let st: fs.Stats
  try {
    st = fs.statSync(scope.abs)
  } catch {
    throw new fsApi.FsError(404, `监视目标不存在：${relPath}`)
  }
  if (!st.isDirectory()) throw new fsApi.FsError(400, 'watch 的 path 必须是目录')

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.write('retry: 3000\n\n')
  res.write(
    `data: ${JSON.stringify({
      ok: true,
      hello: true,
      // 事件 path 相对该目录（posix）
      watch: fsApi.toPosixRel(PROJECTS_ROOT, scope.abs),
    })}\n\n`,
  )

  const watcher = fsApi.watchPath(scope.abs, (events) => {
    // T7.4：快照写入（.history/**）由服务端自动完成，不作为文件变化事件外发，
    // 否则客户端文件树会把快照当普通文件合并显示
    const visible = events.filter((e) => !fsApi.isHiddenRelPath(e.path))
    if (!res.writableEnded && visible.length > 0) res.write(`data: ${JSON.stringify({ ok: true, events: visible })}\n\n`)
  })
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 25000)

  req.on('close', () => {
    clearInterval(ping)
    watcher.close()
    if (!res.writableEnded) res.end()
  })
}

/**
 * T11.4 / PLAN §7.6 资源库变更 SSE：库文件保存/删除/改名后广播 { kind, name, action }。
 * 先 ensureLibraryRoot（失败在写响应头前抛 FsError → 统一 JSON 错误），再发 hello，
 * 订阅 librarySubscribers；断线即退订（客户端降级为「下次打开生效」，不阻塞编辑）。
 */
function handleLibraryWatch(req: IncomingMessage, res: ServerResponse): void {
  libraryApi.ensureLibraryRoot(LIBRARY_ROOT)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.write('retry: 3000\n\n')
  res.write(`data: ${JSON.stringify({ ok: true, hello: true, libraryRoot: LIBRARY_ROOT })}\n\n`)
  const unsubscribe = libraryApi.onLibraryChange((event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ ok: true, events: [event] })}\n\n`)
  })
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 25000)
  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
    if (!res.writableEnded) res.end()
  })
}

/* ============================================================
 * 静态托管（dist/，多入口）
 * ============================================================ */

function serveStatic(pathname: string, res: ServerResponse): void {
  if (!fs.existsSync(DIST_DIR)) {
    sendJson(res, 404, { ok: false, message: 'dist/ 不存在：请先 npm run build（开发模式请访问 vite dev 5173，其 /api 已代理到本服务）' })
    return
  }
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    rel = pathname
  }
  const abs = path.resolve(DIST_DIR, rel.replace(/^\/+/, ''))
  if (!fsApi.isPathWithin(DIST_DIR, abs)) {
    sendJson(res, 403, { ok: false, message: 'Forbidden' })
    return
  }
  let file = abs
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const entry = SPA_ENTRIES[rel]
    if (!entry) {
      sendJson(res, 404, { ok: false, message: `Not Found: ${pathname}` })
      return
    }
    file = path.join(DIST_DIR, entry)
  }
  const stat = fs.statSync(file)
  const mime = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size })
  const stream = fs.createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/* ============================================================
 * WS Hub（正式协议·调试观察通道，T5.4 · 路由实现见 ./ws.ts）
 * ============================================================ */

const wss = new WebSocketServer({ noServer: true })
const wsHub = new WsDebugHub()
wsHub.attach(wss)

// T6.5 持续流推送（仅追加）：plugin.push / plugin.close 协议扩展（hub 实现见
// server/plugins/executor.ts——复用 /ws 连接通道按 project 订阅广播，不改 ws.ts）
executorApi.pluginPushHub.attach(wss)

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

/**
 * 扩展点（T5.4 调试观察协议已落地，见 ./ws.ts）：
 * - T0.4 多窗口拆合：BroadcastChannel 语义跨窗口走 WS 时在此追加房间管理
 */

/* ============================================================
 * 启动
 * ============================================================ */

server.listen(PORT, () => {
  console.log(`[server] Blueprint Studio v2 后端已启动: http://localhost:${PORT}`)
  console.log(`[server] 项目安全根: ${PROJECTS_ROOT}`)
  console.log(`[server] 资源库根: ${LIBRARY_ROOT}（独立安全根，T11.4；SSE /api/library/watch）`)
  console.log(`[server] 静态目录: ${DIST_DIR}（入口 / · /editor.html · /runtime.html）`)
  console.log(`[server] WebSocket: ws://localhost:${PORT}/ws（调试观察协议 debug.v1，T5.4）`)
})
