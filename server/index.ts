/**
 * Blueprint Studio v2 —— 本地服务入口（T0.2 · Server-Agent）
 *
 * 职责：
 *  - REST：/api/projects（列表/新建）· /api/tree · /api/file（GET/PUT/DELETE）·
 *          /api/move · /api/import · /api/watch（SSE）· /api/health
 *  - 静态托管 dist/（多入口：/ · /editor.html · /runtime.html；SPA fallback 仅对已知入口）
 *  - CORS：放行 5173 开发跨域（localhost / 127.0.0.1）
 *  - WS Hub 最小占位（/ws）：只握手 + hello，协议扩展属 T0.4（多窗口）与 T5.4（调试观察）
 *
 * 明确不做（后续卡，留扩展点）：esbuild 转译（T3.3）、插件执行与 CLI 桥（T6.3）、
 * WS 调试协议（T5.4）、.history 快照（T7.4）。
 *
 * 错误格式统一：成功 { ok: true, ... }；失败 { ok: false, message }。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as fsApi from './fs'

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
        wsClients,
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
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ ok: true, events })}\n\n`)
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
 * WS Hub（最小占位，协议扩展属 T0.4 / T5.4）
 * ============================================================ */

const wss = new WebSocketServer({ noServer: true })
let wsClients = 0

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

/**
 * 扩展点（T0.2 只留占位）：
 * - T0.4 多窗口拆合：BroadcastChannel 语义跨窗口走 WS 时在此挂房间管理
 * - T5.4 运行时蓝图观察：调试反向推送（trace / pinValue，150ms 批量）在此挂通道
 */
wss.on('connection', (ws: WebSocket) => {
  wsClients++
  ws.send(
    JSON.stringify({
      type: 'hello',
      hub: 'blueprint-studio-v2',
      protocol: 'placeholder',
      note: 'WS 协议占位（T0.2），扩展见 T0.4 / T5.4',
    }),
  )
  ws.on('close', () => {
    wsClients--
  })
  ws.on('message', () => {
    /* 占位：暂不处理任何消息 */
  })
})

/* ============================================================
 * 启动
 * ============================================================ */

server.listen(PORT, () => {
  console.log(`[server] Blueprint Studio v2 后端已启动: http://localhost:${PORT}`)
  console.log(`[server] 项目安全根: ${PROJECTS_ROOT}`)
  console.log(`[server] 静态目录: ${DIST_DIR}（入口 / · /editor.html · /runtime.html）`)
  console.log(`[server] WebSocket: ws://localhost:${PORT}/ws（占位 hub，协议扩展见 T0.4 / T5.4）`)
})
