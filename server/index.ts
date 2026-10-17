/**
 * Blueprint Studio v2 —— 本地服务入口（T0.2 · Server-Agent）
 *
 * 职责：
 *  - REST：/api/projects（列表/新建）· /api/tree · /api/file（GET/PUT/DELETE）·
 *          /api/move · /api/import · /api/history（T7.4 快照列表）/api/history/restore（恢复）·
 *          /api/watch（SSE）· /api/health
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
import * as pluginsApi from './plugins/registry'
import * as executorApi from './plugins/executor'
import * as transpileApi from './transpile'
import { WsDebugHub } from './ws'

const PORT = Number(process.env.PORT || 8790)
const PROJECTS_ROOT = fsApi.ensureProjectsRoot()
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT_BYTES) throw new fsApi.FsError(413, '请求体过大（>20MB）')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new fsApi.FsError(400, '请求体不是合法 JSON')
  }
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
      sendJson(res, 200, fsApi.writeFileSafe(PROJECTS_ROOT, body.path, body.content))
      return
    }

    if (pathname === '/api/file' && req.method === 'DELETE') {
      sendJson(res, 200, fsApi.deletePathSafe(PROJECTS_ROOT, url.searchParams.get('path') ?? ''))
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
  console.log(`[server] 静态目录: ${DIST_DIR}（入口 / · /editor.html · /runtime.html）`)
  console.log(`[server] WebSocket: ws://localhost:${PORT}/ws（调试观察协议 debug.v1，T5.4）`)
})
