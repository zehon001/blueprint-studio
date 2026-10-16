import fs from 'node:fs'
import path from 'node:path'

export type AssetRecord = {
  name: string
  size: number
  ext: string
  updatedAt: number
}

export const uploadsDir = path.join(process.cwd(), 'assets', 'uploads')

export function ensureAssetsDir() {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

export function listAssets(): AssetRecord[] {
  ensureAssetsDir()
  return fs
    .readdirSync(uploadsDir)
    .filter((f) => fs.statSync(path.join(uploadsDir, f)).isFile())
    .map((f) => {
      const stat = fs.statSync(path.join(uploadsDir, f))
      return {
        name: f,
        size: stat.size,
        ext: path.extname(f).replace('.', '').toLowerCase(),
        updatedAt: stat.mtimeMs,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveAsset(name: string, contentBase64: string): { ok: boolean; message: string } {
  ensureAssetsDir()
  const safe = name.replace(/[^\p{L}\p{N}_. -]/gu, '_')
  if (!safe || safe.includes('..')) return { ok: false, message: '非法文件名' }
  const raw = Buffer.from(contentBase64, 'base64')
  if (raw.length > 20 * 1024 * 1024) return { ok: false, message: '文件过大（上限 20MB）' }
  let target = safe
  let i = 1
  while (fs.existsSync(path.join(uploadsDir, target))) {
    const ext = path.extname(safe)
    target = `${safe.slice(0, safe.length - ext.length)}-${i++}${ext}`
  }
  fs.writeFileSync(path.join(uploadsDir, target), raw)
  return { ok: true, message: `已上传「${target}」（${(raw.length / 1024).toFixed(1)} KB）` }
}

const MIME: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

export function serveAsset(
  _req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  pathname: string,
) {
  const rel = decodeURIComponent(pathname.replace(/^\/assets\//, ''))
  const file = path.join(process.cwd(), 'assets', rel)
  if (!file.startsWith(path.join(process.cwd(), 'assets')) || rel.includes('..')) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not Found')
    return
  }
  const ext = path.extname(file).replace('.', '').toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
  })
  fs.createReadStream(file).pipe(res)
}
