import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { listAssets, saveAsset, serveAsset, ensureAssetsDir } from './assets'
import { createSource, type SourceAdapter, type SourceSpec } from './sources'
import { rpcDispatch } from './rpc'

const PORT = Number(process.env.PORT || 8790)
ensureAssetsDir()

type RunEntry = { socket: WebSocket; adapters: SourceAdapter[] }
const activeRuns = new Map<string, RunEntry>()

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/manifest') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(listAssets()))
      return
    }
    if (req.method === 'POST' && pathname === '/api/assets') {
      const body = JSON.parse(await readBody(req)) as { name?: string; contentBase64?: string }
      const result = saveAsset(String(body.name ?? ''), String(body.contentBase64 ?? ''))
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
      return
    }
    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      serveAsset(req, res, pathname)
      return
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, runs: activeRuns.size }))
      return
    }
    // 生产模式：静态托管前端构建产物（npm run build 后可用）
    if (req.method === 'GET') {
      const distDir = path.join(process.cwd(), 'dist')
      let file = path.join(distDir, pathname === '/' ? 'index.html' : pathname)
      if (!file.startsWith(distDir)) {
        res.writeHead(403).end('Forbidden')
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(distDir, 'index.html')
      }
      if (fs.existsSync(file)) {
        const ext = path.extname(file).replace('.', '')
        const mime: Record<string, string> = {
          html: 'text/html; charset=utf-8',
          js: 'text/javascript; charset=utf-8',
          css: 'text/css; charset=utf-8',
          svg: 'image/svg+xml',
          json: 'application/json; charset=utf-8',
        }
        res.writeHead(200, {
          'Content-Type': mime[ext] ?? 'application/octet-stream',
          'Content-Length': fs.statSync(file).size,
        })
        fs.createReadStream(file).pipe(res)
        return
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, message: 'Not Found' }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, message: String(err) }))
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'hello' }))

  ws.on('message', async (data) => {
    let msg: any
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    try {
      if (msg.type === 'plugin.run') {
        const runId = String(msg.runId ?? '')
        const sources = (msg.sources ?? []) as SourceSpec[]
        if (activeRuns.has(runId)) return
        const entry: RunEntry = { socket: ws, adapters: [] }
        activeRuns.set(runId, entry)
        for (const spec of sources) {
          const adapter = createSource(spec)
          entry.adapters.push(adapter)
          adapter.start(
            (line) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'source.event',
                    runId,
                    sourceId: spec.id,
                    ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                    line,
                  }),
                )
              }
            },
            (level, message) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'source.status', runId, sourceId: spec.id, level, message }))
              }
            },
          )
        }
      } else if (msg.type === 'plugin.stop') {
        stopRun(String(msg.runId ?? ''))
      } else if (msg.type === 'rpc') {
        try {
          const result = await rpcDispatch(String(msg.method), msg.args)
          ws.send(JSON.stringify({ type: 'rpc.result', id: msg.id, ok: true, result }))
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'rpc.result',
              id: msg.id,
              ok: false,
              result: err instanceof Error ? err.message : String(err),
            }),
          )
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: String(err) }))
    }
  })

  ws.on('close', () => {
    for (const [runId, entry] of [...activeRuns]) {
      if (entry.socket === ws) stopRun(runId)
    }
  })
})

function stopRun(runId: string) {
  const entry = activeRuns.get(runId)
  if (!entry) return
  for (const adapter of entry.adapters) adapter.stop()
  activeRuns.delete(runId)
}

server.listen(PORT, () => {
  console.log(`[server] Blueprint Studio 后端已启动: http://localhost:${PORT}`)
  console.log(`[server] WebSocket: ws://localhost:${PORT}/ws`)
})
